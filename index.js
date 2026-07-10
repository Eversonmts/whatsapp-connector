import 'dotenv/config'
import pkg from 'whatsapp-web.js'
const { Client, LocalAuth, MessageMedia } = pkg
import qrcodeTerminal from 'qrcode-terminal'
import QRCode from 'qrcode'
import { createClient } from '@supabase/supabase-js'
import express from 'express'
import fs from 'fs'
import path from 'path'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ACCOUNT_ID = process.env.ACCOUNT_ID

if (!ACCOUNT_ID) {
  console.error('❌ Faltou definir ACCOUNT_ID no arquivo .env. Veja o .env.example.')
  process.exit(1)
}

// Remove travas do Chrome que sobram quando o container é reiniciado sem fechar
// o navegador direito (comum no Railway/Docker com volume persistente) — sem isso,
// o Chrome se recusa a abrir achando que "outro computador" ainda está usando o perfil.
function cleanChromeLocks(dataPath) {
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^Singleton(Lock|Socket|Cookie)$/.test(entry.name)) {
        try {
          fs.unlinkSync(full)
          console.log(`🔓 Trava antiga removida: ${full}`)
        } catch {}
      }
    }
  }
  walk(dataPath)
}
cleanChromeLocks('./.wwebjs_auth')

// Servidor minimo so pra responder o health check do Railway (ele precisa ver algo
// respondendo numa porta HTTP pra considerar o servico "no ar"). Nao faz nada alem disso.
const app = express()
app.get('/', (req, res) => res.send('Conector Sinal rodando OK'))
app.listen(process.env.PORT || 3000, () => console.log(`Health check ouvindo na porta ${process.env.PORT || 3000}`))

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  // fixa numa versão estável do WhatsApp Web: a mais recente tem um bug conhecido
  // que impede a conexão (o QR fica se renovando sem nunca conectar)
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // evita travar por falta de memória compartilhada
      '--disable-gpu',
      '--disable-extensions',
    ],
    protocolTimeout: 180000, // 3 minutos, evita travar em computadores mais lentos
  },
})

client.on('qr', async (qr) => {
  console.log('\nEscaneie o QR Code abaixo no WhatsApp (Aparelhos conectados > Conectar aparelho):\n')
  qrcodeTerminal.generate(qr, { small: true }) // fallback no terminal, se precisar

  const qrImage = await QRCode.toDataURL(qr)
  await supabase
    .from('whatsapp_connection')
    .upsert({ account_id: ACCOUNT_ID, status: 'qr', qr_code: qrImage, updated_at: new Date().toISOString() })
})

client.on('ready', async () => {
  console.log('✅ Conector pronto. WhatsApp conectado.')
  const info = client.info
  await supabase.from('whatsapp_connection').upsert({
    account_id: ACCOUNT_ID,
    status: 'connected',
    qr_code: null,
    phone_number: info?.wid?.user || null,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  await syncLabels()
  await syncHistory()
  watchOutbox()
  watchSyncRequests()
  watchCampaigns()
  watchLabelSyncRequests()

  setInterval(() => {
    console.log('🔄 Sincronização automática periódica...')
    syncHistory()
  }, 10 * 60 * 1000)

  startWatchdog()
})

// ---------- Vigia de saúde da conexão: percebe travamentos e tenta se recuperar ----------
function startWatchdog() {
  setInterval(async () => {
    try {
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
      ])
      if (state !== 'CONNECTED') {
        console.warn(`⚠️  Estado inesperado da conexão: ${state}. Tentando reconectar...`)
        await supabase.from('whatsapp_connection').upsert({ account_id: ACCOUNT_ID, status: 'disconnected', updated_at: new Date().toISOString() })
      }
    } catch (err) {
      console.error('❌ O WhatsApp parou de responder (provável travamento do navegador interno). Reiniciando o conector automaticamente...')
      await supabase.from('whatsapp_connection').upsert({ account_id: ACCOUNT_ID, status: 'disconnected', updated_at: new Date().toISOString() })
      process.exit(1)
    }
  }, 60 * 1000)
}

// ---------- Etiquetas do WhatsApp Business (se a conta tiver esse recurso) ----------
async function syncLabels() {
  try {
    const labels = await client.getLabels()
    if (!labels?.length) return
    console.log(`🏷️  ${labels.length} etiqueta(s) do WhatsApp Business encontrada(s).`)
    for (const label of labels) {
      await supabase.from('whatsapp_labels').upsert(
        { account_id: ACCOUNT_ID, wa_label_id: label.id, name: label.name, color: String(label.hexColor || label.colorIndex || ''), updated_at: new Date().toISOString() },
        { onConflict: 'account_id,wa_label_id' }
      )
    }
  } catch {
    // conta comum (não é WhatsApp Business), sem etiquetas — segue o baile normalmente
  }
}

async function getChatLabelNames(chat) {
  try {
    const labels = await chat.getLabels()
    return {
      names: (labels || []).map((l) => l.name).filter(Boolean),
      ids: (labels || []).map((l) => l.id).filter(Boolean),
    }
  } catch {
    return { names: [], ids: [] }
  }
}

// ---------- Disparo em massa (campanhas), com intervalo de segurança ----------
const runningCampaigns = new Set()

function watchCampaigns() {
  resumeRunningCampaigns()

  supabase
    .channel('campaigns-watch')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns', filter: `account_id=eq.${ACCOUNT_ID}` }, (payload) => {
      if (payload.new?.status === 'running') processCampaign(payload.new.id)
    })
    .subscribe()
}

async function resumeRunningCampaigns() {
  const { data: campaigns } = await supabase.from('campaigns').select('*').eq('account_id', ACCOUNT_ID).eq('status', 'running')
  for (const c of campaigns || []) processCampaign(c.id)
}

function jitter(seconds) {
  const variation = seconds * 0.2
  const value = seconds + (Math.random() * variation * 2 - variation)
  return Math.max(10, Math.round(value)) * 1000
}

async function processCampaign(campaignId) {
  if (runningCampaigns.has(campaignId)) return
  runningCampaigns.add(campaignId)

  try {
    while (true) {
      const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).single()
      if (!campaign || campaign.status !== 'running') break

      const { data: recipient } = await supabase
        .from('campaign_recipients')
        .select('*, contact:contacts(*)')
        .eq('campaign_id', campaignId)
        .eq('status', 'pending')
        .order('created_at')
        .limit(1)
        .maybeSingle()

      if (!recipient) {
        await supabase.from('campaigns').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', campaignId)
        console.log(`✅ Campanha "${campaign.name}" concluída.`)
        break
      }

      try {
        const contact = recipient.contact
        const personalized = campaign.message.replace(/\{\{\s*nome\s*\}\}/gi, contact.name || contact.phone || '')
        await client.sendMessage(contact.whatsapp_id, personalized)

        await supabase.from('campaign_recipients').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', recipient.id)
        await supabase.from('contacts').update({ last_message_at: new Date().toISOString() }).eq('id', contact.id)
      } catch (err) {
        console.error('Erro ao enviar mensagem de campanha:', err)
        await supabase.from('campaign_recipients').update({ status: 'failed' }).eq('id', recipient.id)
      }

      await new Promise((resolve) => setTimeout(resolve, jitter(campaign.delay_seconds)))
    }
  } finally {
    runningCampaigns.delete(campaignId)
  }
}

function watchSyncRequests() {
  supabase
    .channel('sync-requests-watch')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sync_requests', filter: `account_id=eq.${ACCOUNT_ID}` }, () => {
      console.log('🔄 Sincronização manual solicitada pelo site...')
      syncHistory()
    })
    .subscribe()
}

// ---------- Aplica no WhatsApp de verdade as etiquetas marcadas/desmarcadas no CRM ----------
function watchLabelSyncRequests() {
  processPendingLabelRequests()

  supabase
    .channel('label-sync-watch')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'label_sync_requests', filter: `account_id=eq.${ACCOUNT_ID}` }, (payload) => {
      applyLabelChange(payload.new)
    })
    .subscribe()
}

async function processPendingLabelRequests() {
  const { data: pending } = await supabase.from('label_sync_requests').select('*').eq('account_id', ACCOUNT_ID).eq('processed', false)
  for (const req of pending || []) await applyLabelChange(req)
}

async function applyLabelChange(req) {
  try {
    const { data: contact } = await supabase.from('contacts').select('whatsapp_id').eq('id', req.contact_id).single()
    if (!contact?.whatsapp_id) throw new Error('Contato sem whatsapp_id')

    const chat = await client.getChatById(contact.whatsapp_id)
    await chat.changeLabels(req.label_ids)

    console.log(`🏷️  Etiquetas atualizadas no WhatsApp pra ${contact.whatsapp_id}`)
    await supabase.from('label_sync_requests').update({ processed: true }).eq('id', req.id)
  } catch (err) {
    console.error('Erro ao aplicar etiqueta no WhatsApp (só funciona em contas WhatsApp Business):', err.message)
    await supabase.from('label_sync_requests').update({ processed: true }).eq('id', req.id)
  }
}

// ---------- Sincronização inicial: todos os contatos e conversas existentes ----------
async function syncHistory() {
  console.log('🔄 Sincronizando contatos e conversas existentes... isso pode levar alguns minutos na primeira vez.')
  const chats = await client.getChats()
  let done = 0

  for (const chat of chats) {
    try {
      if (chat.isGroup) continue // MVP: ignora grupos

      const contact = await chat.getContact()
      const contactRow = await upsertContact(contact)

      const labelData = await getChatLabelNames(chat)
      if (labelData.names.length) {
        await supabase.from('contacts').update({ wa_labels: labelData.names, wa_label_ids: labelData.ids }).eq('id', contactRow.id)
      }

      const history = await chat.fetchMessages({ limit: 60 })
      for (const msg of history) {
        if (!msg.body && !msg.hasMedia) continue
        const mediaUrl = msg.hasMedia ? await downloadAndStoreMedia(msg) : null
        await supabase
          .from('messages')
          .upsert(
            {
              contact_id: contactRow.id,
              account_id: ACCOUNT_ID,
              direction: msg.fromMe ? 'out' : 'in',
              content: msg.body || null,
              message_type: msg.type,
              media_url: mediaUrl,
              status: msg.fromMe ? 'sent' : 'delivered',
              whatsapp_message_id: msg.id._serialized,
              created_at: new Date(msg.timestamp * 1000).toISOString(),
            },
            { onConflict: 'whatsapp_message_id', ignoreDuplicates: true }
          )
      }

      const lastMsg = history[history.length - 1]
      if (lastMsg) {
        await supabase
          .from('contacts')
          .update({ last_message_at: new Date(lastMsg.timestamp * 1000).toISOString() })
          .eq('id', contactRow.id)
      }

      done++
      if (done % 10 === 0) console.log(`   ...${done}/${chats.length} conversas sincronizadas`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    } catch (err) {
      console.error('Erro sincronizando uma conversa:', err.message)
    }
  }

  console.log(`✅ Sincronização inicial concluída: ${done} conversas.`)
}

client.on('auth_failure', async (msg) => {
  console.error('Falha de autenticação:', msg)
  await supabase.from('whatsapp_connection').upsert({ account_id: ACCOUNT_ID, status: 'disconnected', qr_code: null, updated_at: new Date().toISOString() })
})
client.on('disconnected', async (reason) => {
  console.warn('WhatsApp desconectado:', reason)
  await supabase.from('whatsapp_connection').upsert({ account_id: ACCOUNT_ID, status: 'disconnected', qr_code: null, updated_at: new Date().toISOString() })
})

// ---------- Baixa uma imagem/arquivo recebido e guarda de forma acessível pelo CRM ----------
async function downloadAndStoreMedia(msg) {
  try {
    const media = await msg.downloadMedia()
    if (!media?.data) return null

    const ext = (media.mimetype || '').split('/')[1]?.split(';')[0] || 'bin'
    const path = `${ACCOUNT_ID}/${msg.id._serialized.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`
    const buffer = Buffer.from(media.data, 'base64')

    const { error } = await supabase.storage.from('media').upload(path, buffer, {
      contentType: media.mimetype,
      upsert: true,
    })
    if (error) {
      console.error('Erro ao subir mídia:', error.message)
      return null
    }

    const { data: pub } = supabase.storage.from('media').getPublicUrl(path)
    return pub.publicUrl
  } catch (err) {
    console.error('Erro ao baixar mídia:', err.message)
    return null
  }
}

// ---------- Recebendo e enviando mensagens (inclusive as mandadas direto pelo celular) ----------
// message_create captura TODAS as mensagens, incluindo as enviadas por você direto pelo
// aplicativo do celular — o evento "message" sozinho não pega essas.
client.on('message_create', async (msg) => {
  try {
    if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return

    const chat = await msg.getChat()
    if (chat.isGroup) return // MVP: ignora grupos, só conversas 1:1

    const contact = msg.fromMe ? await chat.getContact() : await msg.getContact()
    const contactRow = await upsertContact(contact)

    const mediaUrl = msg.hasMedia ? await downloadAndStoreMedia(msg) : null

    await supabase.from('messages').upsert(
      {
        contact_id: contactRow.id,
        account_id: ACCOUNT_ID,
        direction: msg.fromMe ? 'out' : 'in',
        content: msg.body || null,
        message_type: msg.type,
        media_url: mediaUrl,
        status: msg.fromMe ? 'sent' : 'delivered',
        whatsapp_message_id: msg.id._serialized,
      },
      { onConflict: 'whatsapp_message_id', ignoreDuplicates: true }
    )

    await supabase.from('contacts').update({ last_message_at: new Date().toISOString() }).eq('id', contactRow.id)

    // só dispara automação/IA pra mensagens que o cliente mandou pra nós, nunca pras que nós mandamos
    if (!msg.fromMe) {
      await maybeAutoReply(msg, contactRow)
    }
  } catch (err) {
    console.error('Erro ao processar mensagem:', err)
  }
})

// atualiza status de leitura/entrega das mensagens enviadas por nós
client.on('message_ack', async (msg, ack) => {
  const statusMap = { 1: 'sent', 2: 'delivered', 3: 'read' }
  const status = statusMap[ack]
  if (!status) return
  await supabase.from('messages').update({ status }).eq('whatsapp_message_id', msg.id._serialized)
})

function isPlausiblePhone(digits) {
  // números reais de WhatsApp (com código do país) ficam nessa faixa; qualquer coisa
  // muito maior que isso costuma ser um código interno (LID) e não um telefone de verdade
  return digits && digits.length >= 10 && digits.length <= 13
}

async function upsertContact(contact) {
  const whatsapp_id = contact.id._serialized
  const isLid = whatsapp_id.endsWith('@lid') // novo sistema de identificação do WhatsApp, sem número real visível

  let phone = null
  if (!isLid && contact.number && isPlausiblePhone(contact.number.replace(/\D/g, ''))) {
    phone = contact.number
  }
  const name = contact.pushname || contact.name || (phone ? phone : null) || 'Contato sem nome'

  let avatar_url = null
  try {
    avatar_url = await contact.getProfilePicUrl()
  } catch {
    avatar_url = null
  }

  const { data: existing } = await supabase.from('contacts').select('*').eq('whatsapp_id', whatsapp_id).maybeSingle()
  if (existing) {
    const updates = {}
    if (name && existing.name !== name) updates.name = name
    if (!phone) {
      // corrige contatos antigos que ficaram com código estranho salvo por engano
      if (existing.phone !== null) updates.phone = null
    } else if (existing.phone !== phone) {
      updates.phone = phone
    }
    if (avatar_url && existing.avatar_url !== avatar_url) updates.avatar_url = avatar_url
    if (Object.keys(updates).length) {
      const { data: updated } = await supabase.from('contacts').update(updates).eq('id', existing.id).select().single()
      return updated || existing
    }
    return existing
  }

  const { data: created } = await supabase
    .from('contacts')
    .insert({ whatsapp_id, phone, name, avatar_url, account_id: ACCOUNT_ID })
    .select()
    .single()
  return created
}

async function maybeAutoReply(msg, contactRow) {
  const { data: rules } = await supabase.from('automation_rules').select('*').eq('active', true).eq('account_id', ACCOUNT_ID)

  const text = (msg.body || '').toLowerCase()
  const rule = (rules || []).find((r) => {
    const kw = r.keyword.toLowerCase()
    if (r.match_type === 'exact') return text === kw
    if (r.match_type === 'starts_with') return text.startsWith(kw)
    return text.includes(kw)
  })

  if (rule) {
    await client.sendMessage(msg.from, rule.response_text)
    return
  }

  await maybeAIReply(msg, contactRow)
}

async function maybeAIReply(msg, contactRow) {
  const hasGemini = !!process.env.GEMINI_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  if (!hasGemini && !hasClaude) return

  const { data: agent } = await supabase.from('ai_agents').select('*').eq('account_id', ACCOUNT_ID).maybeSingle()
  if (!agent?.active) return

  const { data: sub } = await supabase.from('subscriptions').select('*, plan:plans(*)').eq('account_id', ACCOUNT_ID).maybeSingle()
  const limit = sub?.plan?.ai_message_limit
  if (limit && agent.messages_used_this_month >= limit) {
    console.log('⚠️  Limite mensal de mensagens de IA atingido para esta conta.')
    return
  }

  try {
    const { data: recentMsgs } = await supabase
      .from('messages')
      .select('direction, content')
      .eq('contact_id', contactRow.id)
      .order('created_at', { ascending: false })
      .limit(10)

    const history = (recentMsgs || [])
      .reverse()
      .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.content || '' }))

    let systemPrompt = agent.system_prompt
    if (agent.knowledge_base) {
      systemPrompt += `\n\nInformações adicionais que você deve usar para responder:\n${agent.knowledge_base}`
    }
    if (agent.use_product_catalog) {
      const { data: products } = await supabase.from('products').select('name, price, description').eq('account_id', ACCOUNT_ID).eq('active', true)
      if (products?.length) {
        const catalog = products.map((p) => `- ${p.name}: R$ ${Number(p.price).toLocaleString('pt-BR')}${p.description ? ' — ' + p.description : ''}`).join('\n')
        systemPrompt += `\n\nCatálogo de produtos disponíveis:\n${catalog}`
      }
    }

    const replyText = hasGemini
      ? await callGemini(systemPrompt, history, msg.body)
      : await callClaude(systemPrompt, history, msg.body, agent.model)

    if (!replyText) return

    await client.sendMessage(msg.from, replyText)
    await supabase
      .from('ai_agents')
      .update({ messages_used_this_month: agent.messages_used_this_month + 1 })
      .eq('account_id', ACCOUNT_ID)
  } catch (err) {
    console.error('Erro ao gerar resposta com IA:', err)
  }
}

async function callClaude(systemPrompt, history, fallbackBody, model) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5',
      max_tokens: 400,
      system: systemPrompt,
      messages: history.length ? history : [{ role: 'user', content: fallbackBody }],
    }),
  })
  const data = await response.json()
  const text = data?.content?.find((b) => b.type === 'text')?.text
  if (!text) console.error('Resposta da Claude veio vazia:', JSON.stringify(data))
  return text
}

async function callGemini(systemPrompt, history, fallbackBody) {
  const contents = (history.length ? history : [{ role: 'user', content: fallbackBody }]).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
    }),
  })
  const data = await response.json()
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')
  if (!text) console.error('Resposta do Gemini veio vazia:', JSON.stringify(data))
  return text
}

// ---------- Enviando mensagens vindas do CRM (tabela outbox) ----------
function watchOutbox() {
  processPendingOutbox()

  supabase
    .channel('outbox-watch')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'outbox', filter: `account_id=eq.${ACCOUNT_ID}` }, (payload) => {
      sendOutboxRow(payload.new)
    })
    .subscribe()
}

async function processPendingOutbox() {
  const { data: pending } = await supabase.from('outbox').select('*').eq('status', 'pending').eq('account_id', ACCOUNT_ID)
  for (const row of pending || []) await sendOutboxRow(row)
}

async function sendOutboxRow(row) {
  try {
    const { data: contact } = await supabase.from('contacts').select('*').eq('id', row.contact_id).single()
    if (!contact?.whatsapp_id) throw new Error('Contato sem whatsapp_id')

    if (row.media_url) {
      const media = await MessageMedia.fromUrl(row.media_url, { unsafeMime: true })
      await client.sendMessage(contact.whatsapp_id, media, { caption: row.content || undefined })
    } else {
      await client.sendMessage(contact.whatsapp_id, row.content)
    }

    await supabase
      .from('outbox')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', row.id)

    // não insere na tabela messages aqui: o listener message_create já captura
    // essa mesma mensagem (porque ela foi enviada pelo client.sendMessage acima)
    // e faz o upsert sozinho, evitando duplicidade.

    await supabase
      .from('contacts')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', row.contact_id)
  } catch (err) {
    console.error('Erro ao enviar mensagem da outbox:', err)
    await supabase.from('outbox').update({ status: 'failed' }).eq('id', row.id)
  }
}

client.initialize()
