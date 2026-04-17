// ═══════════════════════════════════════════════════════
// ROUTES.JS — Todas as rotas especiais do Estima Food
// PIX · Carteira · Saques · WhatsApp · IA · Auth · Admin
// ═══════════════════════════════════════════════════════
// Para atualizar qualquer funcionalidade:
//   - edite APENAS este arquivo e reinicie o servidor
//   - o server.js não precisa ser tocado
// ═══════════════════════════════════════════════════════
'use strict'

const fs     = require('fs')
const path   = require('path')
const zlib   = require('zlib')
const crypto = require('crypto')

// ── Helper: notifica cliente quando PIX é confirmado (online ou manual) ──────
function _notificarPixConfirmado(tid, order, sendWA, fillVars, EVO_INST, db) {
  if (!order?.phone) return
  setImmediate(async () => {
    try {
      const cfg    = db.prepare('SELECT evo_instance, evo_automacoes, order_num_offset, store_name FROM store_config WHERE tenant_id=?').get(tid)
      const inst   = cfg?.evo_instance || EVO_INST
      const loja   = cfg?.store_name || 'Restaurante'
      const auto   = (() => { try { return JSON.parse(cfg?.evo_automacoes||'{}') } catch { return {} } })()
      const pixConf = auto['pix_confirmado'] || {}
      if (pixConf.on === false) return
      const offset = parseInt(cfg?.order_num_offset) || 0
      const idStr  = String(Math.max(1, order.id - offset)).padStart(3,'0')
      const nome   = order.client || 'Cliente'
      const items  = (()=>{ try{ return (JSON.parse(order.items)||[]).map(i=>`• ${i.qty}x ${i.name}`).join('\n') }catch{ return '' } })()
      const total  = (parseFloat(order.total||0)+parseFloat(order.taxa||0)).toFixed(2).replace('.',',')
      const msgPad = `🏪 *${loja}*\n${'─'.repeat(20)}\n\n✅ *Pagamento PIX confirmado!*\n\nOlá, *${nome}*! Recebemos seu pagamento do pedido *#${idStr}* com sucesso.\n\n*Itens:*\n${items}\n\n💰 *Total: R$ ${total}*\n\n📦 Seu pedido está sendo preparado. Obrigado! 🎉\n\n_Dúvidas? É só responder esta mensagem!_ 😊`
      const msgFin = pixConf.msg ? fillVars(pixConf.msg, { nome, id: idStr, itens: items, total, loja }) : msgPad
      await sendWA(order.phone, msgFin, inst)
    } catch(e) { /* silencia erros de notificação */ }
  })
}

module.exports = async function handleRoutes(req, res, ctx) {
  const { upath, params, db, send, readBody, log, sseBroadcast, marcarDirty,
          validarSessaoAdmin, criarSessaoAdmin, fazerBackup, restaurarBackup, getTenantId,
          MP_TOKEN, TAXA_PIX, BACKUP_PATH, UPLOADS_DIR,
          EVO_URL, EVO_KEY, EVO_INST, sendWA, fillVars, sleep, checarAniv, handleIAWebhook, _pausaHumano } = ctx

  // ═══════════════════════════════════════════════════════
  // Departamentos WhatsApp
  // ═══════════════════════════════════════════════════════

  // ── Listar departamentos ─────────────────────────────
  if (req.method === 'GET' && upath === '/api/wa/departamentos') {
    const tid = req.headers['x-tenant-id'] || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    const depts = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM wa_conv_dept c WHERE c.dept_id=d.id AND c.tenant_id=d.tenant_id) AS total_convs,
        u.id AS supervisor_id, u.nome AS supervisor_nome, u.email AS supervisor_email
      FROM wa_departments d
      LEFT JOIN sys_users u ON u.dept_id=d.id AND u.tenant_id=d.tenant_id
      WHERE d.tenant_id=? ORDER BY d.sort_order, d.id
    `).all(tid)
    send(res, 200, depts)
    return true
  }

  // ── Criar departamento ───────────────────────────────
  if (req.method === 'POST' && upath === '/api/wa/departamentos') {
    const tid  = req.headers['x-tenant-id'] || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    const body = await readBody(req)
    const { nome, descricao, keywords, cor } = body
    if (!nome) { send(res, 400, { error: 'Nome obrigatório' }); return true }
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM wa_departments WHERE tenant_id=?').get(tid)?.m || 0
    const r = db.prepare('INSERT INTO wa_departments (tenant_id,nome,descricao,keywords,cor,sort_order) VALUES (?,?,?,?,?,?)')
      .run(tid, nome.trim(), descricao || '', keywords || '', cor || '#6366f1', maxOrder + 1)
    const dept = db.prepare('SELECT * FROM wa_departments WHERE id=?').get(r.lastInsertRowid)
    marcarDirty()
    send(res, 200, dept)
    return true
  }

  // ── Atualizar departamento ───────────────────────────
  if (req.method === 'PATCH' && upath.startsWith('/api/wa/departamentos/')) {
    const tid    = req.headers['x-tenant-id'] || ''
    const deptId = parseInt(upath.split('/').pop())
    if (!tid || !deptId) { send(res, 400, { error: 'Inválido' }); return true }
    const owns = db.prepare('SELECT id FROM wa_departments WHERE id=? AND tenant_id=?').get(deptId, tid)
    if (!owns) { send(res, 404, { error: 'Departamento não encontrado' }); return true }
    const body = await readBody(req)
    const fields = ['nome','descricao','keywords','cor','sort_order']
    const sets   = fields.filter(f => body[f] !== undefined).map(f => `${f}=?`)
    const vals   = fields.filter(f => body[f] !== undefined).map(f => body[f])
    if (sets.length) {
      db.prepare(`UPDATE wa_departments SET ${sets.join(',')} WHERE id=? AND tenant_id=?`).run(...vals, deptId, tid)
      marcarDirty()
    }
    // Atribuir/remover supervisor
    if (body.supervisor_id !== undefined) {
      const supId = body.supervisor_id || null
      // Remove vínculo antigo deste dept
      db.prepare("UPDATE sys_users SET dept_id=NULL WHERE dept_id=? AND tenant_id=?").run(deptId, tid)
      // Vincula novo supervisor
      if (supId) db.prepare("UPDATE sys_users SET dept_id=?, role='supervisor' WHERE id=? AND tenant_id=?").run(deptId, supId, tid)
      marcarDirty()
    }
    const dept = db.prepare('SELECT * FROM wa_departments WHERE id=?').get(deptId)
    send(res, 200, dept)
    return true
  }

  // ── Excluir departamento ─────────────────────────────
  if (req.method === 'DELETE' && upath.startsWith('/api/wa/departamentos/')) {
    const tid    = req.headers['x-tenant-id'] || ''
    const deptId = parseInt(upath.split('/').pop())
    if (!tid || !deptId) { send(res, 400, { error: 'Inválido' }); return true }
    const owns = db.prepare('SELECT id FROM wa_departments WHERE id=? AND tenant_id=?').get(deptId, tid)
    if (!owns) { send(res, 404, { error: 'Não encontrado' }); return true }
    // Remove vínculos
    db.prepare("UPDATE sys_users SET dept_id=NULL, role='gestor' WHERE dept_id=? AND tenant_id=?").run(deptId, tid)
    db.prepare('DELETE FROM wa_conv_dept WHERE dept_id=? AND tenant_id=?').run(deptId, tid)
    db.prepare('DELETE FROM wa_departments WHERE id=? AND tenant_id=?').run(deptId, tid)
    marcarDirty()
    send(res, 200, { ok: true })
    return true
  }

  // ── Listar usuários disponíveis para supervisor ──────
  if (req.method === 'GET' && upath === '/api/wa/departamentos-usuarios') {
    const tid = req.headers['x-tenant-id'] || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    const users = db.prepare("SELECT id,nome,email,role,dept_id FROM sys_users WHERE tenant_id=? AND ativo=1 ORDER BY nome").all(tid)
    send(res, 200, users)
    return true
  }

  // ── Departamento de uma conversa ─────────────────────
  if (req.method === 'GET' && upath === '/api/wa/conv-dept') {
    const tid = req.headers['x-tenant-id'] || ''
    const jid = params.get('jid') || ''
    if (!tid || !jid) { send(res, 400, { error: 'tid e jid obrigatórios' }); return true }
    const row = db.prepare(`
      SELECT c.*, d.nome AS dept_nome, d.cor AS dept_cor,
             u.id AS atendente_id, u.nome AS atendente_nome
      FROM wa_conv_dept c
      LEFT JOIN wa_departments d ON d.id=c.dept_id
      LEFT JOIN sys_users u ON u.id=c.atendente_id
      WHERE c.tenant_id=? AND c.jid=?
    `).get(tid, jid)
    send(res, 200, row || null)
    return true
  }

  // ── Atribuir conversa a departamento + atendente ──────
  if (req.method === 'POST' && upath === '/api/wa/conv-dept') {
    const tid  = req.headers['x-tenant-id'] || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    const body = await readBody(req)
    const { jid, dept_id, atendente_id } = body
    if (!jid) { send(res, 400, { error: 'jid obrigatório' }); return true }
    if (dept_id) {
      db.prepare(`INSERT INTO wa_conv_dept (tenant_id,jid,dept_id,atendente_id,assigned_at)
        VALUES (?,?,?,?,datetime('now'))
        ON CONFLICT(tenant_id,jid) DO UPDATE SET
          dept_id=excluded.dept_id,
          atendente_id=excluded.atendente_id,
          assigned_at=excluded.assigned_at`
      ).run(tid, jid, dept_id, atendente_id || null)
    } else {
      db.prepare('DELETE FROM wa_conv_dept WHERE tenant_id=? AND jid=?').run(tid, jid)
    }
    marcarDirty()
    send(res, 200, { ok: true })
    return true
  }

  // ── Listar JIDs de um departamento (supervisor/atendente) ─
  if (req.method === 'GET' && upath === '/api/wa/conv-por-dept') {
    const tid         = req.headers['x-tenant-id'] || ''
    const deptId      = params.get('dept_id') || ''
    const atendenteId = params.get('atendente_id') || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    let rows
    if (atendenteId) {
      // atendente: só conversas atribuídas a ele
      rows = db.prepare('SELECT jid FROM wa_conv_dept WHERE tenant_id=? AND atendente_id=?').all(tid, atendenteId)
    } else if (deptId) {
      // supervisor: todas as convs do dept
      rows = db.prepare('SELECT jid FROM wa_conv_dept WHERE tenant_id=? AND dept_id=?').all(tid, deptId)
    } else {
      rows = []
    }
    send(res, 200, rows.map(r => r.jid))
    return true
  }

  // ── Criar atendente ───────────────────────────────────
  if (req.method === 'POST' && upath === '/api/wa/atendentes') {
    const tid  = req.headers['x-tenant-id'] || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    const body = await readBody(req)
    const { nome, email, senha, dept_id } = body
    if (!nome || !email || !senha) { send(res, 400, { error: 'nome, email e senha obrigatórios' }); return true }
    if (db.prepare('SELECT id FROM sys_users WHERE email=?').get(email.toLowerCase().trim())) {
      send(res, 400, { error: 'E-mail já cadastrado.' }); return true
    }
    const hash = require('crypto').createHash('sha256').update(senha).digest('hex')
    const r = db.prepare("INSERT INTO sys_users (nome,email,senha_hash,role,tenant_id,dept_id) VALUES (?,?,?,?,?,?)")
      .run(nome.trim(), email.toLowerCase().trim(), hash, 'atendente', tid, dept_id || null)
    const user = db.prepare('SELECT id,nome,email,role,dept_id FROM sys_users WHERE id=?').get(r.lastInsertRowid)
    marcarDirty()
    send(res, 200, user)
    return true
  }

  // ── Editar atendente ──────────────────────────────────
  if (req.method === 'PATCH' && upath.startsWith('/api/wa/atendentes/')) {
    const tid    = req.headers['x-tenant-id'] || ''
    const userId = upath.split('/').pop()
    if (!tid || !userId) { send(res, 400, { error: 'Inválido' }); return true }
    const owns = db.prepare("SELECT id FROM sys_users WHERE id=? AND tenant_id=? AND role='atendente'").get(userId, tid)
    if (!owns) { send(res, 404, { error: 'Atendente não encontrado' }); return true }
    const body = await readBody(req)
    const sets = [], vals = []
    if (body.nome)    { sets.push('nome=?');    vals.push(body.nome.trim()) }
    if (body.email)   { sets.push('email=?');   vals.push(body.email.toLowerCase().trim()) }
    if (body.dept_id !== undefined) { sets.push('dept_id=?'); vals.push(body.dept_id || null) }
    if (body.ativo !== undefined)   { sets.push('ativo=?');   vals.push(body.ativo ? 1 : 0) }
    if (body.senha) {
      const hash = require('crypto').createHash('sha256').update(body.senha).digest('hex')
      sets.push('senha_hash=?'); vals.push(hash)
    }
    if (sets.length) {
      db.prepare(`UPDATE sys_users SET ${sets.join(',')} WHERE id=? AND tenant_id=?`).run(...vals, userId, tid)
      marcarDirty()
    }
    const user = db.prepare('SELECT id,nome,email,role,ativo,dept_id FROM sys_users WHERE id=?').get(userId)
    send(res, 200, user)
    return true
  }

  // ── Excluir atendente ─────────────────────────────────
  if (req.method === 'DELETE' && upath.startsWith('/api/wa/atendentes/')) {
    const tid    = req.headers['x-tenant-id'] || ''
    const userId = upath.split('/').pop()
    if (!tid || !userId) { send(res, 400, { error: 'Inválido' }); return true }
    const owns = db.prepare("SELECT id FROM sys_users WHERE id=? AND tenant_id=? AND role='atendente'").get(userId, tid)
    if (!owns) { send(res, 404, { error: 'Atendente não encontrado' }); return true }
    // Remove atribuições de conversa
    db.prepare('UPDATE wa_conv_dept SET atendente_id=NULL WHERE atendente_id=? AND tenant_id=?').run(userId, tid)
    db.prepare('DELETE FROM sys_users WHERE id=? AND tenant_id=?').run(userId, tid)
    marcarDirty()
    send(res, 200, { ok: true })
    return true
  }

  // ── Listar atendentes com stats ────────────────────────
  if (req.method === 'GET' && upath === '/api/wa/atendentes') {
    const tid    = req.headers['x-tenant-id'] || ''
    const deptId = params.get('dept_id') || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    const rows = db.prepare(`
      SELECT u.id, u.nome, u.email, u.role,
        (SELECT COUNT(*) FROM wa_conv_dept c WHERE c.atendente_id=u.id AND c.tenant_id=u.tenant_id) AS total_convs
      FROM sys_users u
      WHERE u.tenant_id=? AND u.ativo=1 AND u.role='atendente' ${deptId ? 'AND u.dept_id=?' : ''}
      ORDER BY u.nome
    `).all(...[tid, deptId ? deptId : undefined].filter(Boolean))
    send(res, 200, rows)
    return true
  }

  // ── Atribuir atendente a conversa ─────────────────────
  if (req.method === 'POST' && upath === '/api/wa/atribuir-atendente') {
    const tid  = req.headers['x-tenant-id'] || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    const body = await readBody(req)
    const { jid, atendente_id } = body
    if (!jid) { send(res, 400, { error: 'jid obrigatório' }); return true }
    // Garante que a linha existe
    const existe = db.prepare('SELECT jid FROM wa_conv_dept WHERE tenant_id=? AND jid=?').get(tid, jid)
    if (existe) {
      db.prepare('UPDATE wa_conv_dept SET atendente_id=? WHERE tenant_id=? AND jid=?').run(atendente_id || null, tid, jid)
    } else {
      db.prepare(`INSERT INTO wa_conv_dept (tenant_id,jid,atendente_id,assigned_at) VALUES (?,?,?,datetime('now'))`).run(tid, jid, atendente_id || null)
    }
    marcarDirty()
    // Broadcast SSE para atualizar o painel em tempo real
    try { sseBroadcast(`wa-dept:${tid}`, 'wa:atribuicao', { jid, atendente_id: atendente_id || null }) } catch {}
    send(res, 200, { ok: true })
    return true
  }

  // ── Info de todas as convs com atendente (para listas do gestor) ─
  if (req.method === 'GET' && upath === '/api/wa/conv-atendentes') {
    const tid    = req.headers['x-tenant-id'] || ''
    const deptId = params.get('dept_id') || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    const rows = db.prepare(`
      SELECT c.jid, c.dept_id, c.atendente_id,
             u.nome AS atendente_nome, u.email AS atendente_email
      FROM wa_conv_dept c
      LEFT JOIN sys_users u ON u.id=c.atendente_id
      WHERE c.tenant_id=? ${deptId ? 'AND c.dept_id=?' : ''}
    `).all(...[tid, deptId ? deptId : undefined].filter(Boolean))
    // retorna mapa jid → {atendente_id, atendente_nome}
    const map = {}
    rows.forEach(r => { map[r.jid] = { atendente_id: r.atendente_id, atendente_nome: r.atendente_nome } })
    send(res, 200, map)
    return true
  }

  // ═══════════════════════════════════════════════════════
  // Auth — Clientes
  // ═══════════════════════════════════════════════════════


  // ── Registro de cliente (cardápio) ───────────────────
  if (req.method === 'POST' && upath === '/api/customer-register') {
    const body = await readBody(req)
    const tid  = getTenantId(req, params)
    const { name, phone, email, senha, birthday } = body
    if (!name || !phone || !senha) { send(res, 400, { error: 'Nome, telefone e senha são obrigatórios' }); return true }
    if (!tid) { send(res, 400, { error: 'Tenant não identificado' }); return true }
    try {
      const hash     = crypto.createHash('sha256').update(senha).digest('hex')
      const existing = db.prepare('SELECT id FROM customers WHERE tenant_id=? AND phone=?').get(tid, phone)
      if (existing) {
        db.prepare('UPDATE customers SET name=?,email=?,birthday=?,senha_hash=? WHERE tenant_id=? AND phone=?').run(name, email || null, birthday || null, hash, tid, phone)
        const c = db.prepare('SELECT id,name,phone,email,birthday,orders_count,total_spent,created_at FROM customers WHERE tenant_id=? AND phone=?').get(tid, phone)
        send(res, 200, { ...c, token: Buffer.from(`${c.id}:${tid}:${hash.slice(0, 16)}`).toString('base64') })
        return true
      }
      const info = db.prepare('INSERT INTO customers (tenant_id,name,phone,email,birthday,senha_hash,orders_count,total_spent) VALUES (?,?,?,?,?,?,0,0)').run(tid, name, phone, email || null, birthday || null, hash)
      const c    = db.prepare('SELECT id,name,phone,email,birthday,orders_count,total_spent,created_at FROM customers WHERE id=?').get(info.lastInsertRowid)
      marcarDirty()
      send(res, 201, { ...c, token: Buffer.from(`${c.id}:${tid}:${hash.slice(0, 16)}`).toString('base64') })
    } catch (e) { send(res, 400, { error: e.message }) }
    return true
  }

  // ── Login de cliente (cardápio) ──────────────────────
  if (req.method === 'POST' && upath === '/api/customer-login') {
    const body = await readBody(req)
    const tid  = getTenantId(req, params)
    const { phone, senha } = body
    if (!phone || !senha) { send(res, 400, { error: 'Telefone e senha obrigatórios' }); return true }
    if (!tid) { send(res, 400, { error: 'Tenant não identificado' }); return true }
    try {
      const hash = crypto.createHash('sha256').update(senha).digest('hex')
      const c    = db.prepare('SELECT id,name,phone,email,birthday,orders_count,total_spent,created_at,senha_hash FROM customers WHERE tenant_id=? AND phone=?').get(tid, phone)
      if (!c || !c.senha_hash) { send(res, 401, { error: 'Telefone não cadastrado' }); return true }
      if (c.senha_hash !== hash) { send(res, 401, { error: 'Senha incorreta' }); return true }
      const { senha_hash: _, ...safe } = c
      send(res, 200, { ...safe, token: Buffer.from(`${c.id}:${tid}:${hash.slice(0, 16)}`).toString('base64') })
    } catch (e) { send(res, 400, { error: e.message }) }
    return true
  }

  // ── Pedidos do cliente ───────────────────────────────
  if (req.method === 'GET' && upath === '/api/customer-orders') {
    const tid = getTenantId(req, params)
    const cid = params.get('customer_id')
    if (!tid || !cid) { send(res, 400, { error: 'Parâmetros faltando' }); return true }
    try {
      const rows = db.prepare('SELECT id,order_num,client,phone,addr,items,total,taxa,pag,status,created_at FROM orders WHERE tenant_id=? AND customer_id=? ORDER BY id DESC LIMIT 30').all(tid, cid)
      send(res, 200, rows.map(r => ({ ...r, items: (() => { try { return JSON.parse(r.items) } catch { return [] } })() })))
    } catch (e) { send(res, 400, { error: e.message }) }
    return true
  }

  // ═══════════════════════════════════════════════════════
  // Admin, Backup & Tenants
  // ═══════════════════════════════════════════════════════


  // ── Login admin ──────────────────────────────────────
  if (req.method === 'POST' && upath === '/api/admin-login') {
    const body = await readBody(req)
    const { email, senha_hash } = body
    if (!email || !senha_hash) { send(res, 400, { error: 'email e senha_hash obrigatórios' }); return true }
    const u = db.prepare("SELECT id,nome,email,role FROM sys_users WHERE email=? AND senha_hash=? AND ativo=1 AND role IN ('superadmin','admin')").get(email.toLowerCase().trim(), senha_hash)
    if (!u) { send(res, 401, { error: 'Acesso negado. Credenciais inválidas.' }); return true }
    const token = criarSessaoAdmin(u)
    send(res, 200, { ok: true, id: u.id, nome: u.nome, email: u.email, role: u.role, token })
    return true
  }

  // ── Logout admin ─────────────────────────────────────
  if (req.method === 'POST' && upath === '/api/admin-logout') {
    const auth  = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (token) db.prepare('DELETE FROM admin_sessions WHERE token=?').run(token)
    send(res, 200, { ok: true })
    return true
  }

  // ── Criar tenant ─────────────────────────────────────
  if (req.method === 'POST' && upath === '/api/criar-tenant') {
    const body = await readBody(req)
    const { nome, plano, slug, email, senha, role, nomeGestor, segmento } = body
    if (!nome || !email || !senha) { send(res, 400, { error: 'nome, email e senha obrigatórios' }); return true }
    try {
      const hash     = crypto.createHash('sha256').update(senha).digest('hex')
      const slugBase = slug || nome.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/, '')
      let slugFinal  = slugBase, suffix = 2
      while (db.prepare('SELECT id FROM tenants WHERE slug=?').get(slugFinal)) slugFinal = `${slugBase}-${suffix++}`
      if (slug && slugFinal !== slug) { send(res, 400, { error: `Slug "${slug}" já em uso. Sugerimos: "${slugFinal}"` }); return true }
      if (db.prepare('SELECT id FROM sys_users WHERE email=?').get(email)) { send(res, 400, { error: `E-mail "${email}" já cadastrado.` }); return true }
      const seg = ['restaurante','acougue'].includes(segmento) ? segmento : 'restaurante'
      db.prepare('INSERT INTO tenants (nome,plano,slug,segmento) VALUES (?,?,?,?)').run(nome, plano || 'basic', slugFinal, seg)
      const t = db.prepare('SELECT id FROM tenants WHERE slug=?').get(slugFinal)
      db.prepare('INSERT OR IGNORE INTO store_config (tenant_id) VALUES (?)').run(t.id)
      // Define offset = max(id) atual para que o 1º pedido deste tenant comece em #1
      const maxOrderId = db.prepare('SELECT COALESCE(MAX(id),0) as m FROM orders').get()?.m || 0
      db.prepare('UPDATE store_config SET order_num_offset=? WHERE tenant_id=?').run(maxOrderId, t.id)
      db.prepare('INSERT INTO sys_users (nome,email,senha_hash,role,tenant_id) VALUES (?,?,?,?,?)').run(nomeGestor || nome, email, hash, role || 'gestor', t.id)

      // ── Seed de categorias padrão por segmento ──────────────────────────
      if (seg === 'acougue') {
        const catInsert = db.prepare("INSERT INTO categories (tenant_id,name,label,type,emoji,sort_order,ativo) VALUES (?,?,?,?,?,?,1)")
        const catsAcougue = [
          { name: 'bovinos',  label: 'Bovinos',         emoji: '🐄', sort: 1 },
          { name: 'suinos',   label: 'Suínos',           emoji: '🐷', sort: 2 },
          { name: 'aves',     label: 'Aves',             emoji: '🐔', sort: 3 },
          { name: 'ovinos',   label: 'Ovinos',           emoji: '🐑', sort: 4 },
          { name: 'embutidos',label: 'Embutidos',        emoji: '🌭', sort: 5 },
          { name: 'kits',     label: 'Kits & Combos',    emoji: '📦', sort: 6 },
          { name: 'temperos', label: 'Temperos & Acompanhamentos', emoji: '🧄', sort: 7 },
        ]
        catsAcougue.forEach(c => catInsert.run(t.id, c.name, c.label, 'Itens principais', c.emoji, c.sort))
        // Tema e cor padrão do açougue
        db.prepare('UPDATE store_config SET store_tema=?, store_cor=? WHERE tenant_id=?').run('tropical', '#b45309', t.id)
        log('🥩', `Categorias padrão açougue criadas para tenant=${t.id}`)
      } else {
        const catInsert = db.prepare("INSERT INTO categories (tenant_id,name,label,type,emoji,sort_order,ativo) VALUES (?,?,?,?,?,?,1)")
        const catsRest = [
          { name: 'entradas',  label: 'Entradas',    emoji: '🥗', sort: 1 },
          { name: 'pratos',    label: 'Pratos',       emoji: '🍽️', sort: 2 },
          { name: 'bebidas',   label: 'Bebidas',      emoji: '🥤', sort: 3 },
          { name: 'sobremesas',label: 'Sobremesas',   emoji: '🍰', sort: 4 },
        ]
        catsRest.forEach(c => catInsert.run(t.id, c.name, c.label, 'Itens principais', c.emoji, c.sort))
      }
      // ────────────────────────────────────────────────────────────────────

      marcarDirty()
      setTimeout(() => fazerBackup(true), 2000)
      send(res, 201, { ok: true, tenant_id: t.id, slug: slugFinal, segmento: seg })
    } catch (e) { send(res, 400, { error: e.message }) }
    return true
  }

  // ── Backup simples (trigger) ─────────────────────────
  if (req.method === 'POST' && upath === '/api/backup') {
    fazerBackup(true)
    const size = fs.existsSync(BACKUP_PATH) ? fs.statSync(BACKUP_PATH).size : 0
    send(res, 200, { ok: true, path: BACKUP_PATH, size })
    return true
  }

  // ── Restore simples ──────────────────────────────────
  if (req.method === 'POST' && upath === '/api/restore') {
    const ok = restaurarBackup()
    send(res, 200, { ok, msg: ok ? 'Restauração concluída' : 'Nenhum backup encontrado' })
    return true
  }

  // ── Endpoints /api/admin-backup/* ────────────────────
  if (upath.startsWith('/api/admin-backup')) {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Não autorizado. Faça login no painel admin.' }); return true }

    // ── Lê ia_config de um tenant (usado pelo painel IA) ──
    if (req.method === 'GET' && upath === '/api/admin-backup/ia-config') {
      const tid = params.get('tenant_id') || '_global'
      try {
        const row = db.prepare('SELECT ia_config FROM store_config WHERE tenant_id=?').get(tid)
        send(res, 200, { ia_config: row?.ia_config || null })
      } catch(e) { send(res, 500, { error: e.message }) }
      return true
    }

    // ── Salva ia_config de um tenant (usado pelo painel IA) ──
    if (req.method === 'POST' && upath === '/api/admin-backup/ia-config') {
      const tid  = params.get('tenant_id') || '_global'
      const body = await readBody(req)
      const { ia_config } = body
      if (!ia_config) { send(res, 400, { error: 'ia_config obrigatório' }); return true }
      try {
        db.prepare("INSERT INTO store_config (tenant_id,ia_config) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET ia_config=excluded.ia_config").run(tid, typeof ia_config === 'string' ? ia_config : JSON.stringify(ia_config))
        marcarDirty()
        send(res, 200, { ok: true })
      } catch(e) { send(res, 500, { error: e.message }) }
      return true
    }

    // Download backup JSON
    if (req.method === 'GET' && upath === '/api/admin-backup-download') {
      fazerBackup(true)
      if (!fs.existsSync(BACKUP_PATH)) { send(res, 404, { error: 'Nenhum backup disponível' }); return true }
      const data  = fs.readFileSync(BACKUP_PATH, 'utf8')
      const fname = `backup-completo-${new Date().toISOString().slice(0, 10)}.json`
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${fname}"`, 'Content-Length': Buffer.byteLength(data) })
      res.end(data)
      return true
    }

    // Restore global com imagens
    if (req.method === 'POST' && upath === '/api/admin-backup-restore-global') {
      try {
        const body = await readBody(req)
        if (!body?.tabelas) { send(res, 400, { error: 'JSON inválido (falta "tabelas")' }); return true }
        const TABS = ['tenants', 'sys_users', 'store_config', 'categories', 'menu_items', 'cupons', 'mesas', 'garcons', 'orders', 'movimentos', 'estoque', 'fidelidade', 'customers', 'ratings']
        let totalOk = 0, totalFail = 0
        for (const t of TABS) {
          const rows = body.tabelas?.[t]; if (!rows?.length) continue
          try {
            const cols = Object.keys(rows[0])
            const stmt = db.prepare(`INSERT OR IGNORE INTO "${t}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
            const ins  = db.transaction(items => { let ok = 0; for (const r of items) { try { stmt.run(Object.values(r)); ok++ } catch { totalFail++ } } return ok })
            totalOk += ins(rows)
          } catch (e) { log('⚠️', `Restore ${t}: ${e.message}`) }
        }
        let imgOk = 0, imgFail = 0
        for (const [fname, img] of Object.entries(body.imagens || {})) {
          try {
            if (!img?.data || !/^[A-Za-z0-9+/=]+$/.test(img.data.replace(/\s/g, ''))) continue
            fs.writeFileSync(path.join(UPLOADS_DIR, path.basename(fname)), Buffer.from(img.data, 'base64'))
            imgOk++
          } catch (e) { imgFail++; log('⚠️', `Restore img ${fname}: ${e.message}`) }
        }
        marcarDirty(); setTimeout(() => fazerBackup(true), 2000)
        send(res, 200, { ok: true, registros: totalOk, registros_ignorados: totalFail, imagens: imgOk, imagens_falha: imgFail, ts: body.ts || null })
      } catch (e) { send(res, 400, { error: 'Erro ao restaurar: ' + e.message }) }
      return true
    }

    send(res, 404, { error: 'Rota admin não encontrada' })
    return true
  }

  // ── Backup completo do gestor (dados + imagens) ──────
  if (req.method === 'GET' && upath === '/api/backup-completo-gestor') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    const tenant = db.prepare('SELECT id,nome,slug FROM tenants WHERE id=?').get(tid)
    if (!tenant) { send(res, 404, { error: 'Tenant não encontrado' }); return true }
    try {
      const TABS     = ['sys_users', 'store_config', 'categories', 'menu_items', 'cupons', 'mesas', 'garcons', 'orders', 'movimentos', 'estoque', 'fidelidade', 'customers', 'ratings']
      const snapshot = { ts: new Date().toISOString(), tenant_id: tid, tenant_nome: tenant.nome, tabelas: { tenants: [tenant] }, imagens: {} }
      for (const t of TABS) { try { snapshot.tabelas[t] = db.prepare(`SELECT * FROM "${t}" WHERE tenant_id=?`).all(tid) } catch { snapshot.tabelas[t] = [] } }
      const imageUrls = new Set()
      ;(snapshot.tabelas.menu_items || []).forEach(r => { if (r.image_url) imageUrls.add(r.image_url) })
      const cfg = (snapshot.tabelas.store_config || [])[0]
      if (cfg) { if (cfg.store_logo_url) imageUrls.add(cfg.store_logo_url); if (cfg.store_banner_url) imageUrls.add(cfg.store_banner_url) }
      for (const url of imageUrls) {
        const fname = path.basename(url.split('?')[0])
        const fpath = path.join(UPLOADS_DIR, fname)
        if (fs.existsSync(fpath)) {
          const ext  = (path.extname(fname).slice(1) || 'jpeg').toLowerCase()
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
          snapshot.imagens[fname] = { mime, data: fs.readFileSync(fpath).toString('base64') }
        }
      }
      const json  = JSON.stringify(snapshot)
      const slug  = tenant.slug || tid
      const fname = `backup-completo-${slug}-${new Date().toISOString().slice(0, 10)}.json`
      log('💾', `Backup completo gestor: ${slug} (${imageUrls.size} imagem(ns), ${Math.round(json.length / 1024)}KB)`)
      zlib.gzip(Buffer.from(json, 'utf8'), (err, compressed) => {
        if (err) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${fname}"`, 'Content-Length': Buffer.byteLength(json) })
          res.end(json)
        } else {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${fname}.gz"`, 'Content-Encoding': 'gzip', 'Content-Length': compressed.length })
          res.end(compressed)
        }
      })
    } catch (e) { send(res, 500, { error: 'Erro ao gerar backup: ' + e.message }) }
    return true
  }

  // ═══════════════════════════════════════════════════════
  // PIX, Carteira & Saques
  // ═══════════════════════════════════════════════════════


  // ── Gera cobrança PIX via Mercado Pago ───────────────
  if (req.method === 'POST' && upath === '/api/pix/criar') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    const body = await readBody(req)
    const { valor, order_id, client, email = 'pagador@email.com' } = body
    if (!valor || valor <= 0) { send(res, 400, { error: 'valor inválido' }); return true }

    let mpToken = MP_TOKEN
    let taxa = TAXA_PIX
    try {
      const cfgMp = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const gCfg = cfgMp?.ia_config ? JSON.parse(cfgMp.ia_config) : {}
      if (gCfg.mp_token) mpToken = gCfg.mp_token
      if (gCfg.taxa_pix !== undefined) taxa = parseFloat(gCfg.taxa_pix) || 0
    } catch {}
    if (!mpToken) { send(res, 400, { error: 'Token Mercado Pago não configurado. Configure no painel Admin → Configurações.' }); return true }

    const extRef = `ef-${tid.slice(0, 8)}-${order_id || Date.now()}`
    const valorLiq = Math.max(0, parseFloat(valor) - taxa)

    try {
      const mp = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mpToken}`, 'X-Idempotency-Key': extRef },
        body: JSON.stringify({
          transaction_amount: parseFloat(valor),
          description: `Pedido #${order_id || '?'} - ${client || 'Cliente'}`,
          payment_method_id: 'pix',
          external_reference: extRef,
          payer: { email, first_name: client || 'Cliente', last_name: '' },
        })
      })
      const mpData = await mp.json()
      if (!mp.ok) { log('❌', 'MP PIX erro:', mpData); send(res, 400, { error: mpData.message || 'Erro MP' }); return true }

      const qr    = mpData.point_of_interaction?.transaction_data?.qr_code || ''
      const qrB64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64 || ''

      db.prepare(`INSERT OR IGNORE INTO pagamentos_pix
        (tenant_id,order_id,mp_payment_id,mp_external_ref,valor,taxa,valor_liquido,status,payer_name,qr_code,qr_code_base64)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(tid, order_id || null, String(mpData.id), extRef, parseFloat(valor), taxa, valorLiq,
          (mpData.status==='approved'?'aprovado':mpData.status==='rejected'?'rejeitado':mpData.status==='cancelled'?'cancelado':'pendente'),
          client || '', qr, qrB64)

      log('💳', `PIX criado: R$${valor} tenant=${tid} mp_id=${mpData.id}`)
      send(res, 200, { ok: true, mp_payment_id: mpData.id, qr_code: qr, qr_code_base64: qrB64, valor, taxa, valor_liquido: valorLiq, status: mpData.status })

      // ── Envia copia e cola via WhatsApp ────────────────────────────────────
      if (qr && body.phone) {
        setImmediate(async () => {
          try {
            const cfgWa  = db.prepare('SELECT evo_instance, evo_automacoes, order_num_offset FROM store_config WHERE tenant_id=?').get(tid)
            const inst   = cfgWa?.evo_instance || EVO_INST
            const auto   = (() => { try { return JSON.parse(cfgWa?.evo_automacoes||'{}') } catch { return {} } })()
            const pixCop = auto['pix_copia_cola'] || {}
            if (pixCop.on === false) return
            const offset = parseInt(cfgWa?.order_num_offset) || 0
            const idStr  = String(Math.max(1, (body.order_id || 0) - offset)).padStart(3,'0')
            const nome   = client || 'Cliente'
            const fmtVal = parseFloat(valor).toFixed(2).replace('.',',')
            // Mensagem 1: texto com instruções (customizável pelo gestor, sem o código)
            const nomeLoja  = cfgWa?.store_name || 'Restaurante'
            const msgPadTxt = `🏪 *${nomeLoja}*\n${'─'.repeat(20)}\n\n💠 *PIX — Pedido #${idStr}*\n\nOlá, *${nome}*! Para confirmar seu pedido, realize o pagamento via PIX Copia e Cola.\n\n💰 *Valor: R$ ${fmtVal}*\n\nO código PIX chegará na próxima mensagem — só copiar e colar no app! 👇`
            const msgTxt = pixCop.msg ? fillVars(pixCop.msg.replace('{codigo_pix}', '').trim(), { nome, id: idStr, total: fmtVal, codigo_pix: '' }).trim() : msgPadTxt
            await sendWA(body.phone, msgTxt, inst)
            // Mensagem 2: só o código (separado para facilitar cópia)
            await new Promise(r => setTimeout(r, 1000))
            await sendWA(body.phone, qr, inst)
            log('📤', `PIX copia e cola enviado WA → ${body.phone}`)
          } catch(e) { log('⚠️', 'Erro WA PIX copia e cola:', e.message) }
        })
      }
      // ──────────────────────────────────────────────────────────────────────
    } catch (e) { log('❌', 'MP fetch erro:', { error: e.message }); send(res, 500, { error: 'Erro ao criar PIX: ' + e.message }) }
    return true
  }

  // ── Consulta status PIX ──────────────────────────────
  if (req.method === 'GET' && upath === '/api/pix/status') {
    const mpId = params.get('mp_payment_id') || ''
    if (!mpId) { send(res, 400, { error: 'mp_payment_id obrigatório' }); return true }
    const tid = req.headers['x-tenant-id'] || ''
    if (tid) {
      const own = db.prepare('SELECT tenant_id FROM pagamentos_pix WHERE mp_payment_id=?').get(String(mpId))
      if (own && own.tenant_id !== tid) { send(res, 403, { error: 'Acesso negado' }); return true }
    }
    let mpToken = MP_TOKEN
    try { const c = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get(); const g = c?.ia_config ? JSON.parse(c.ia_config) : {}; if (g.mp_token) mpToken = g.mp_token } catch {}
    if (!mpToken) { send(res, 400, { error: 'Token MP não configurado' }); return true }
    try {
      const r = await fetch('https://api.mercadopago.com/v1/payments/' + mpId, { headers: { 'Authorization': 'Bearer ' + mpToken } })
      const pd = await r.json()
      if (!r.ok) { const fb = db.prepare('SELECT status FROM pagamentos_pix WHERE mp_payment_id=?').get(String(mpId)); send(res, 200, { status: fb ? fb.status : 'pendente' }); return true }
      const novoStatus = pd.status === 'approved' ? 'aprovado' : pd.status === 'rejected' ? 'rejeitado' : pd.status === 'cancelled' ? 'cancelado' : 'pendente'
      const rowAtual = db.prepare('SELECT status,valor,tenant_id,order_id FROM pagamentos_pix WHERE mp_payment_id=?').get(String(mpId))
      if (rowAtual && rowAtual.status !== novoStatus) {
        db.prepare('UPDATE pagamentos_pix SET status=?,paid_at=? WHERE mp_payment_id=?').run(novoStatus, pd.date_approved || null, String(mpId))
        if (novoStatus === 'aprovado') {
          log('✅', `PIX APROVADO: R$${rowAtual.valor} tenant=${rowAtual.tenant_id}`)
          marcarDirty()
          // Se pedido ainda estava aguardando PIX, libera para o gestor agora
          if (rowAtual.order_id) {
            const pedAtual = db.prepare("SELECT status FROM orders WHERE id=?").get(rowAtual.order_id)
            if (pedAtual?.status === 'aguardando_pix') {
              db.prepare("UPDATE orders SET status='analise', pag='pix_mp' WHERE id=?").run(rowAtual.order_id)
              const _fo1 = db.prepare("SELECT * FROM orders WHERE id=?").get(rowAtual.order_id)
              const _it1 = _fo1 && typeof _fo1.items==='string' ? (() => { try{return JSON.parse(_fo1.items)}catch{return []} })() : (_fo1?.items||[])
              sseBroadcast(`orders-rt:${rowAtual.tenant_id}`, `orders:UPDATE`, _fo1 ? {..._fo1, items:_it1, status:'analise', pag:'pix_mp'} : { id: rowAtual.order_id, status: 'analise', pag: 'pix_mp' })
              // Notifica cliente: pagamento PIX confirmado
              _notificarPixConfirmado(rowAtual.tenant_id, _fo1, sendWA, fillVars, EVO_INST, db)
            }
          }
        }
      }
      send(res, 200, { status: novoStatus, mp_status: pd.status })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Vincula PIX ao pedido ────────────────────────────
  if (req.method === 'POST' && upath === '/api/pix/vincular') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    const body = await readBody(req)
    const mpId = String(body.mp_payment_id || ''), ordId = parseInt(body.order_id) || 0
    if (!mpId || !ordId) { send(res, 400, { error: 'obrigatórios' }); return true }
    // Verifica ownership: o pagamento deve pertencer ao tenant
    const pixRow = db.prepare('SELECT tenant_id FROM pagamentos_pix WHERE mp_payment_id=?').get(mpId)
    if (!pixRow) { send(res, 404, { error: 'Pagamento não encontrado' }); return true }
    if (pixRow.tenant_id !== tid) { send(res, 403, { error: 'Acesso negado' }); return true }
    // Verifica ownership do pedido
    const orderRow = db.prepare('SELECT tenant_id FROM orders WHERE id=?').get(ordId)
    if (!orderRow || orderRow.tenant_id !== tid) { send(res, 403, { error: 'Pedido não pertence ao tenant' }); return true }
    db.prepare('UPDATE pagamentos_pix SET order_id=? WHERE mp_payment_id=?').run(ordId, mpId)
    db.prepare("UPDATE orders SET pag='pix_mp' WHERE id=?").run(ordId)
    marcarDirty()
    send(res, 200, { ok: true })
    return true
  }

  // ── Lê config PIX do tenant ──────────────────────────
  if (req.method === 'GET' && upath === '/api/pix/config') {
    const tid = req.headers['x-tenant-id'] || params.get('tenant_id') || ''
    if (!tid) { send(res, 400, { error: 'tenant_id obrigatório' }); return true }
    try {
      const safeJson = (v) => { try { return v ? JSON.parse(v) : {} } catch { return {} } }
      const cfg  = db.prepare('SELECT ia_config FROM store_config WHERE tenant_id=?').get(tid)
      const ia   = safeJson(cfg?.ia_config)
      const gCfg = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const gIa  = safeJson(gCfg?.ia_config)
      const mpConfigurado  = !!(gIa.mp_token || MP_TOKEN)
      const pixAtivo       = ia.pix_ativo === true
      const pagOnlineAtivo = ia.pag_online_ativo !== false
      const cartaoDisponivel   = !!(gIa.mp_public_key)           // só disponível se admin configurou a public key
      const cartaoOnlineAtivo  = ia.cartao_online_ativo !== false && cartaoDisponivel
      send(res, 200, {
        pix_ativo:            pixAtivo,
        pix_ativo_gestor:     pixAtivo,
        mp_configurado:       mpConfigurado,
        taxa_pix:             gIa.taxa_pix !== undefined ? parseFloat(gIa.taxa_pix) : parseFloat(process.env.TAXA_PIX || '1.00'),
        pix_key_manual:       ia.pix_key_manual || '',
        pix_key_manual_tipo:  ia.pix_key_manual_tipo || '',
        pix_key_manual_banco: ia.pix_key_manual_banco || '',
        pag_online_ativo:     pagOnlineAtivo,
        cartao_disponivel:    cartaoDisponivel,
        cartao_online_ativo:  cartaoOnlineAtivo,
      })
    } catch (e) { log('❌', '/api/pix/config erro:', e.message); send(res, 500, { error: e.message }) }
    return true
  }

  // ── Gestor salva config PIX ──────────────────────────
  if (req.method === 'POST' && upath === '/api/pix/gestor-config') {
    const tid = req.headers['x-tenant-id'] || ''
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    const body = await readBody(req)
    try {
      const cfg = db.prepare('SELECT ia_config FROM store_config WHERE tenant_id=?').get(tid)
      const ia  = cfg?.ia_config ? JSON.parse(cfg.ia_config) : {}
      if (body.pix_ativo !== undefined)            ia.pix_ativo            = body.pix_ativo !== false
      if (body.pix_key_manual !== undefined)        ia.pix_key_manual       = body.pix_key_manual || ''
      if (body.pix_key_manual_tipo !== undefined)   ia.pix_key_manual_tipo  = body.pix_key_manual_tipo || ''
      if (body.pix_key_manual_banco !== undefined)  ia.pix_key_manual_banco = body.pix_key_manual_banco || ''
      if (body.pag_online_ativo !== undefined)      ia.pag_online_ativo     = body.pag_online_ativo !== false
      if (body.cartao_online_ativo !== undefined)   ia.cartao_online_ativo  = body.cartao_online_ativo !== false
      db.prepare('INSERT INTO store_config (tenant_id,ia_config) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET ia_config=excluded.ia_config').run(tid, JSON.stringify(ia))
      marcarDirty()
      log('⚙️', `PIX/pagamentos config salva tenant=${tid} pix_ativo=${ia.pix_ativo} pag_online=${ia.pag_online_ativo}`)
      send(res, 200, { ok: true, pix_ativo: ia.pix_ativo, pix_key_manual: ia.pix_key_manual || '', pag_online_ativo: ia.pag_online_ativo !== false, cartao_online_ativo: ia.cartao_online_ativo !== false })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Webhook Mercado Pago ─────────────────────────────
  if (req.method === 'POST' && upath === '/webhook/mercadopago') {
    const body = await readBody(req)
    const mpId = body?.data?.id || body?.id
    if (!mpId) { send(res, 200, { ok: true }); return true }
    let mpToken = MP_TOKEN
    try { const c = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get(); const g = c?.ia_config ? JSON.parse(c.ia_config) : {}; if (g.mp_token) mpToken = g.mp_token } catch {}
    if (!mpToken) { send(res, 200, { ok: true }); return true }
    try {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${mpId}`, { headers: { 'Authorization': `Bearer ${mpToken}` } })
      const pd = await r.json()
      if (!r.ok) { send(res, 200, { ok: true }); return true }
      const novoStatus = pd.status === 'approved' ? 'aprovado' : pd.status === 'rejected' ? 'rejeitado' : pd.status === 'cancelled' ? 'cancelado' : 'pendente'
      const row = db.prepare('SELECT status,valor,tenant_id,order_id FROM pagamentos_pix WHERE mp_payment_id=?').get(String(mpId))
      if (row && row.status !== novoStatus) {
        db.prepare('UPDATE pagamentos_pix SET status=?,paid_at=? WHERE mp_payment_id=?').run(novoStatus, pd.date_approved || null, String(mpId))
        marcarDirty()
        if (novoStatus === 'aprovado') {
          log('✅', `Webhook MP APROVADO: R$${row.valor} tenant=${row.tenant_id}`)
          if (row.order_id) {
            const pedAtual = db.prepare("SELECT status FROM orders WHERE id=?").get(row.order_id)
            const eraAguardando = pedAtual?.status === 'aguardando_pix'
            if (eraAguardando) {
              db.prepare("UPDATE orders SET status='analise', pag='pix_mp' WHERE id=?").run(row.order_id)
            } else {
              db.prepare("UPDATE orders SET pag='pix_mp' WHERE id=?").run(row.order_id)
            }
            const _ns4 = eraAguardando ? 'analise' : pedAtual?.status
            const _fo4 = db.prepare("SELECT * FROM orders WHERE id=?").get(row.order_id)
            const _it4 = _fo4 && typeof _fo4.items==='string' ? (() => { try{return JSON.parse(_fo4.items)}catch{return []} })() : (_fo4?.items||[])
            sseBroadcast(`orders-rt:${row.tenant_id}`, `orders:UPDATE`, _fo4 ? {..._fo4, items:_it4, status:_ns4, pag:'pix_mp'} : { id: row.order_id, status: _ns4, pag: 'pix_mp' })
            // Notifica cliente: pagamento PIX confirmado
            if (eraAguardando) _notificarPixConfirmado(row.tenant_id, _fo4, sendWA, fillVars, EVO_INST, db)
          }
        }
      }
    } catch (e) { log('❌', 'Webhook MP erro:', e.message) }
    send(res, 200, { ok: true })
    return true
  }

  // ── Saldo da carteira ────────────────────────────────
  if (req.method === 'GET' && upath === '/api/carteira') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    try {
      // PIX aprovados
      const pixRecebido  = db.prepare("SELECT COALESCE(SUM(valor_liquido),0) as v FROM pagamentos_pix WHERE tenant_id=? AND status='aprovado'").get(tid)?.v || 0
      const pixTaxas     = db.prepare("SELECT COALESCE(SUM(taxa),0) as v FROM pagamentos_pix WHERE tenant_id=? AND status='aprovado'").get(tid)?.v || 0
      const pixCount     = db.prepare("SELECT COUNT(*) as c FROM pagamentos_pix WHERE tenant_id=? AND status='aprovado'").get(tid)?.c || 0
      const ultimosPix   = db.prepare("SELECT * FROM pagamentos_pix WHERE tenant_id=? ORDER BY created_at DESC LIMIT 10").all(tid)
      const pixPendentes = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(valor),0) as v FROM pagamentos_pix WHERE tenant_id=? AND status='pendente'").get(tid)

      // Cartão online aprovados (taxa = 7% já descontada na hora do pagamento)
      const cartaoRows   = db.prepare("SELECT COALESCE(SUM(valor),0) as bruto, COUNT(*) as c FROM pagamentos_cartao WHERE tenant_id=? AND status='aprovado'").get(tid)
      const cartaoBruto  = cartaoRows?.bruto || 0
      const cartaoCount  = cartaoRows?.c || 0
      const TAXA_CARTAO  = 0.07
      const cartaoLiq    = cartaoBruto * (1 - TAXA_CARTAO)
      const cartaoTaxas  = cartaoBruto * TAXA_CARTAO
      const ultimosCartao= db.prepare("SELECT * FROM pagamentos_cartao WHERE tenant_id=? ORDER BY created_at DESC LIMIT 10").all(tid)

      // Total recebido = PIX líquido + Cartão líquido
      const totalRecebido = pixRecebido + cartaoLiq
      const totalTaxas    = pixTaxas + cartaoTaxas
      const totalPagamentos = pixCount + cartaoCount

      // Saques já solicitados/pagos
      const totalSacado   = db.prepare("SELECT COALESCE(SUM(valor_liquido),0) as v FROM saques WHERE tenant_id=? AND status IN ('pendente','aprovado','pago')").get(tid)?.v || 0
      const saldoDisp     = Math.max(0, totalRecebido - totalSacado)

      let taxaPix = 1.00
      try { const gc = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get(); const g = gc?.ia_config ? JSON.parse(gc.ia_config) : {}; if (g.taxa_pix !== undefined) taxaPix = parseFloat(g.taxa_pix) || 0 } catch {}

      send(res, 200, {
        saldo_disponivel:  saldoDisp,
        total_recebido:    totalRecebido,
        total_sacado:      totalSacado,
        total_taxas:       totalTaxas,
        taxa_por_pagamento: taxaPix,
        total_pagamentos:  totalPagamentos,
        pix_recebido:      pixRecebido,
        pix_count:         pixCount,
        cartao_recebido:   cartaoLiq,
        cartao_bruto:      cartaoBruto,
        cartao_count:      cartaoCount,
        ultimos_pagamentos: ultimosPix,
        ultimos_cartao:    ultimosCartao,
        pendentes_count:   pixPendentes?.c || 0,
        pendentes_valor:   pixPendentes?.v || 0,
      })
    } catch (e) { log('❌', '/api/carteira erro:', e.message); send(res, 500, { error: e.message }) }
    return true
  }

  // ── Solicitar saque ──────────────────────────────────
  if (req.method === 'POST' && upath === '/api/saques/solicitar') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    try {
      const body = await readBody(req)
      const { pix_key, pix_key_tipo = 'aleatoria' } = body
      if (!pix_key) { send(res, 400, { error: 'Chave PIX obrigatória' }); return true }

      // PIX aprovados
      const pixLiq  = db.prepare("SELECT COALESCE(SUM(valor_liquido),0) as v FROM pagamentos_pix WHERE tenant_id=? AND status='aprovado'").get(tid)?.v || 0
      // Cartão aprovados (desconta 7% taxa)
      const cartaoB = db.prepare("SELECT COALESCE(SUM(valor),0) as v FROM pagamentos_cartao WHERE tenant_id=? AND status='aprovado'").get(tid)?.v || 0
      const cartaoLiq = cartaoB * 0.93

      const totalRecebido = pixLiq + cartaoLiq
      const totalSacado   = db.prepare("SELECT COALESCE(SUM(valor_liquido),0) as v FROM saques WHERE tenant_id=? AND status IN ('pendente','aprovado','pago')").get(tid)?.v || 0
      const saldo = Math.max(0, totalRecebido - totalSacado)

      if (saldo < 1) { send(res, 400, { error: 'Saldo insuficiente para saque' }); return true }
      const jaTemPendente = db.prepare("SELECT id FROM saques WHERE tenant_id=? AND status='pendente'").get(tid)
      if (jaTemPendente) { send(res, 400, { error: 'Você já tem um saque pendente aguardando aprovação' }); return true }

      const numPix    = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(taxa),0) as t FROM pagamentos_pix WHERE tenant_id=? AND status='aprovado'").get(tid)
      const numCartao = db.prepare("SELECT COUNT(*) as c FROM pagamentos_cartao WHERE tenant_id=? AND status='aprovado'").get(tid)
      const numTotal  = (numPix?.c || 0) + (numCartao?.c || 0)
      const taxaTotal = (numPix?.t || 0) + (cartaoB * 0.07)

      const tenant  = db.prepare('SELECT nome FROM tenants WHERE id=?').get(tid)
      const saqInfo = db.prepare(`INSERT INTO saques (tenant_id,tenant_nome,valor_solicitado,num_pagamentos,taxa_total,valor_liquido,pix_key,pix_key_tipo)
        VALUES (?,?,?,?,?,?,?,?)`).run(tid, tenant?.nome || tid, saldo, numTotal, taxaTotal, saldo, pix_key, pix_key_tipo)
      const saqNovo = db.prepare('SELECT * FROM saques WHERE id=?').get(saqInfo.lastInsertRowid)
      sseBroadcast('saques-admin', 'saques:INSERT', saqNovo)
      sseBroadcast(`saques-rt:${tid}`, 'saques:INSERT', saqNovo)
      marcarDirty()
      log('💰', `Saque solicitado: R$${saldo.toFixed(2)} tenant=${tid} (pix=${pixLiq.toFixed(2)} + cartão=${cartaoLiq.toFixed(2)})`)
      send(res, 200, { ok: true, valor: saldo, pix_key })
    } catch (e) { log('❌', '/api/saques/solicitar erro:', e.message); send(res, 500, { error: e.message }) }
    return true
  }

  // ── Lista saques do gestor ───────────────────────────
  if (req.method === 'GET' && upath === '/api/saques/meus') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    try {
      const saques = db.prepare('SELECT * FROM saques WHERE tenant_id=? ORDER BY created_at DESC').all(tid)
      send(res, 200, saques)
    } catch (e) { log('❌', '/api/saques/meus erro:', e.message); send(res, 500, { error: e.message }) }
    return true
  }

  // ── Admin: lista todos os saques ─────────────────────
  if (req.method === 'GET' && upath === '/api/admin/saques') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Não autorizado' }); return true }
    const status = params.get('status') || 'pendente'
    const saques = db.prepare('SELECT s.*,t.slug FROM saques s LEFT JOIN tenants t ON s.tenant_id=t.id WHERE s.status=? ORDER BY s.created_at ASC').all(status)
    send(res, 200, saques)
    return true
  }

  // ── Admin: atualiza status de um saque ───────────────
  if (req.method === 'PATCH' && upath === '/api/admin/saques/atualizar') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Não autorizado' }); return true }
    const body = await readBody(req)
    const { id, status, obs_admin } = body
    if (!id || !status) { send(res, 400, { error: 'id e status obrigatórios' }); return true }
    const paid_at = status === 'pago' ? new Date().toISOString() : null
    db.prepare('UPDATE saques SET status=?,obs_admin=?,paid_at=COALESCE(?,paid_at) WHERE id=?').run(status, obs_admin || null, paid_at, id)
    const saqAtual = db.prepare('SELECT * FROM saques WHERE id=?').get(id)
    if (saqAtual) { sseBroadcast(`saques-rt:${saqAtual.tenant_id}`, 'saques:UPDATE', saqAtual); sseBroadcast('saques-admin', 'saques:UPDATE', saqAtual) }
    marcarDirty()
    log('💰', `Saque #${id} → ${status}`)
    send(res, 200, { ok: true })
    return true
  }

  // ── Admin: salvar token MP e taxa ────────────────────
  if (req.method === 'POST' && upath === '/api/admin/mp-config') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Não autorizado' }); return true }
    const body = await readBody(req)
    const { mp_token, taxa_pix, mp_public_key } = body
    try {
      const cfgMp = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const cur   = cfgMp?.ia_config ? JSON.parse(cfgMp.ia_config) : {}
      if (mp_token)      cur.mp_token      = mp_token
      if (mp_public_key) cur.mp_public_key = mp_public_key
      if (taxa_pix !== undefined) cur.taxa_pix = parseFloat(taxa_pix)
      db.prepare("INSERT INTO store_config (tenant_id,ia_config) VALUES ('_global',?) ON CONFLICT(tenant_id) DO UPDATE SET ia_config=excluded.ia_config").run(JSON.stringify(cur))
      marcarDirty()
      send(res, 200, { ok: true })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Admin: ler config MP ─────────────────────────────
  if (req.method === 'GET' && upath === '/api/admin/mp-config') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Não autorizado' }); return true }
    try {
      const row      = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const cfg      = row?.ia_config ? JSON.parse(row.ia_config) : {}
      const mp_token = cfg.mp_token ? '••••' + cfg.mp_token.slice(-6) : ''
      const taxa_pix = cfg.taxa_pix !== undefined ? cfg.taxa_pix : TAXA_PIX
      const mp_public_key_mascarado = cfg.mp_public_key ? '••••' + cfg.mp_public_key.slice(-6) : ''
      send(res, 200, { mp_token_mascarado: mp_token, taxa_pix, mp_configurado: !!cfg.mp_token, mp_public_key_mascarado, mp_public_key_configurado: !!cfg.mp_public_key })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Admin: toggle PIX por tenant ─────────────────────
  if (req.method === 'POST' && upath === '/api/admin/pix-toggle') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Não autorizado' }); return true }
    const body = await readBody(req)
    const { tenant_id, pix_ativo } = body
    if (!tenant_id) { send(res, 400, { error: 'tenant_id obrigatório' }); return true }
    try {
      const cfg = db.prepare('SELECT ia_config FROM store_config WHERE tenant_id=?').get(tenant_id)
      const cur = cfg?.ia_config ? JSON.parse(cfg.ia_config) : {}
      cur.pix_ativo = pix_ativo !== false
      db.prepare('INSERT INTO store_config (tenant_id,ia_config) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET ia_config=excluded.ia_config').run(tenant_id, JSON.stringify(cur))
      marcarDirty()
      send(res, 200, { ok: true, pix_ativo: cur.pix_ativo })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ═══════════════════════════════════════════════════════
  // WhatsApp, IA & Webhooks
  // ═══════════════════════════════════════════════════════


  // ── Envio manual de mensagem WA ──────────────────────
  if (req.method === 'POST' && upath === '/enviar') {
    const { phone, text, tenant_id } = await readBody(req)
    if (!phone || !text) { send(res, 400, { ok: false, error: 'phone e text obrigatórios' }); return true }
    const tid    = tenant_id || req.headers['x-tenant-id']
    const cfgEnv = tid ? db.prepare('SELECT evo_instance FROM store_config WHERE tenant_id=?').get(tid) : null
    const r      = await sendWA(phone, text, cfgEnv?.evo_instance)
    send(res, r.ok ? 200 : 500, r)
    return true
  }

  // ── Disparo de promoção em massa ─────────────────────
  if (req.method === 'POST' && upath === '/promocao') {
    const body = await readBody(req)
    const { destino = 'todos', msg, tenant_id } = body
    if (!msg) { send(res, 400, { ok: false, error: 'msg obrigatório' }); return true }
    const tid  = tenant_id || req.headers['x-tenant-id']
    const cfgP = tid ? db.prepare('SELECT evo_instance FROM store_config WHERE tenant_id=?').get(tid) : null
    const instP = cfgP?.evo_instance || EVO_INST
    let cl = db.prepare('SELECT * FROM fidelidade WHERE phone IS NOT NULL' + (tid ? ' AND tenant_id=?' : '')).all(...(tid ? [tid] : []))
    if (destino === 'com_pedido') cl = cl.filter(c => c.orders_count > 0)
    if (!cl.length) { send(res, 200, { ok: true, enviados: 0 }); return true }
    send(res, 200, { ok: true, total: cl.length, msg: 'Envio iniciado' })
    ;(async () => {
      let ok = 0, fail = 0
      for (const c of cl) { const r = await sendWA(c.phone, fillVars(msg, { nome: c.name }), instP); r.ok ? ok++ : fail++; await sleep(1500) }
      log('📢', `Promoção: ${ok} ok, ${fail} fail`)
    })()
    return true
  }

  // ── Disparar verificação de aniversariantes ──────────
  if (req.method === 'POST' && upath === '/aniversario') {
    checarAniv()
    send(res, 200, { ok: true })
    return true
  }

  // ── Rastreio via WA (IA responde status do pedido) ───
  if (req.method === 'POST' && upath === '/api/rastreio-wa') {
    const { phone, order_id, tenant_id } = await readBody(req)
    if (!phone || !order_id || !tenant_id) { send(res, 400, { ok: false }); return true }
    const cfg         = db.prepare('SELECT evo_instance,store_name,ia_config,order_num_offset FROM store_config WHERE tenant_id=?').get(tenant_id)
    const inst        = cfg?.evo_instance || EVO_INST
    const ia          = cfg?.ia_config ? JSON.parse(cfg.ia_config) : {}
    if (!ia.ativo && !ia.resp_rastreio_manual) { send(res, 200, { ok: false, msg: 'IA inativa' }); return true }
    const pedido      = db.prepare('SELECT id,status,items,total,taxa FROM orders WHERE id=? AND tenant_id=?').get(order_id, tenant_id)
    if (!pedido) { send(res, 400, { ok: false }); return true }
    const sl          = { analise: '⏳ aguardando confirmação', producao: '👨‍🍳 em preparo', pronto: '🛵 saindo para entrega', entregue: '✅ entregue', cancelado: '❌ cancelado' }
    const offset      = parseInt(cfg?.order_num_offset || 0) || 0
    const numPedido   = String(Math.max(1, pedido.id - offset)).padStart(3, '0')
    const totalComTaxa = (parseFloat(pedido.total||0) + parseFloat(pedido.taxa||0)).toFixed(2).replace('.', ',')
    const msg         = `🍽️ *${cfg?.store_name || 'Restaurante'}*\n\nOlá! Seu pedido *#${numPedido}* está:\n\n${sl[pedido.status] || pedido.status}\n\nTotal: R$ ${totalComTaxa}\n\nQualquer dúvida é só responder! 😊`
    const r           = await sendWA(phone, msg, inst)
    send(res, r.ok ? 200 : 500, r)
    return true
  }

  // ── Humano assumiu conversa (pausa IA) ───────────────
  if (req.method === 'POST' && upath === '/api/ia-humano-assumiu') {
    const body = await readBody(req)
    const { phone, tenant_id } = body
    log('👤', '[PAUSA-DEBUG] Body recebido:', JSON.stringify(body))
    log('👤', '[PAUSA-DEBUG] phone extraído:', phone, '| tenant_id extraído:', tenant_id)
    log('👤', '[PAUSA-DEBUG] x-tenant-id header:', req.headers['x-tenant-id'])
    if (phone && tenant_id) {
      const pausaKey = `pausa:${tenant_id}:${phone}`
      _pausaHumano.set(pausaKey, Date.now())
      log('👤', `[PAUSA-DEBUG] Chave gravada no _pausaHumano: "${pausaKey}"`)
      log('👤', `[PAUSA-DEBUG] Total de chaves no _pausaHumano: ${_pausaHumano.size}`)
      log('👤', `Humano assumiu conversa com ${phone}`)
    } else {
      log('⚠️', '[PAUSA-DEBUG] FALHOU — phone ou tenant_id ausente no body:', { phone, tenant_id })
    }
    send(res, 200, { ok: true })
    return true
  }

  // ── Proxy Evolution API (/api/evo/*) ─────────────────
  if (upath.startsWith('/api/evo')) {
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId) { send(res, 401, { error: 'x-tenant-id obrigatório' }); return true }
    const cfg      = db.prepare('SELECT evo_instance FROM store_config WHERE tenant_id=?').get(tenantId)
    const instance = cfg?.evo_instance || null
    const body     = ['POST', 'DELETE'].includes(req.method) ? await readBody(req) : {}
    const action   = upath.replace('/api/evo', '')
    if (req.method === 'POST' && body.instanceName === undefined && instance && action.startsWith('/instance/')) body.instanceName = instance
    const evoPath  = action.replace(':instance', instance || '')
    try {
      const r    = await fetch(`${EVO_URL}${evoPath}`, { method: req.method, headers: { 'Content-Type': 'application/json', apikey: EVO_KEY }, body: req.method !== 'GET' ? JSON.stringify(body) : undefined })
      const data = await r.json().catch(() => ({}))
      if (evoPath.startsWith('/instance/create') && r.ok && body.instanceName) db.prepare('UPDATE store_config SET evo_instance=? WHERE tenant_id=?').run(body.instanceName, tenantId)
      send(res, r.status, data)
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Webhook WhatsApp / IA ────────────────────────────
  if (req.method === 'POST' && (upath.startsWith('/webhook/whatsapp') || upath.startsWith('/webhook/'))) {
    const body  = await readBody(req)
    const event = body?.event || ''

    // Resolve tenant a partir da URL
    const tid_wh = (() => {
      if (upath.startsWith('/webhook/whatsapp')) return upath.split('/')[3] || null
      const slug = upath.split('/')[2] || null
      if (!slug) return null
      const row = db.prepare('SELECT id FROM tenants WHERE slug=? OR id=?').get(slug, slug)
      return row?.id || null
    })()

    // Broadcast SSE + salva no banco — mensagens recebidas E enviadas
    if (tid_wh && (event === 'messages.upsert' || event === 'message.upsert')) {
      const msgs = Array.isArray(body?.data?.messages)
        ? body.data.messages
        : (body?.data ? [body.data] : [])

      const stmt = db.prepare(
        'INSERT OR IGNORE INTO wa_messages (tenant_id, remote_jid, msg_id, payload, from_me, ts) VALUES (?,?,?,?,?,?)'
      )

      for (const m of msgs) {
        const fromMe = m?.key?.fromMe === true || m?.key?.fromMe === 'true'
        const jid    = m?.key?.remoteJid || ''
        const mid    = m?.key?.id || ''
        const ts     = +m?.messageTimestamp || 0

        // Só ignora status e LIDs — qualquer outra mensagem é válida
        if (!jid || !mid || jid.startsWith('status@') || jid.endsWith('@lid')) continue

        // Salva no banco (recebidas e enviadas)
        try {
          stmt.run(tid_wh, jid, mid, JSON.stringify(m), fromMe ? 1 : 0, ts)
          marcarDirty()
        } catch(e) { /* UNIQUE — já existe */ }

        // ── Auto-atribuição por keywords (só msgs recebidas, 1ª vez) ─────
        if (!fromMe && tid_wh) {
          const jaTemDept = db.prepare('SELECT dept_id FROM wa_conv_dept WHERE tenant_id=? AND jid=?').get(tid_wh, jid)
          if (!jaTemDept) {
            const texto = (
              m?.message?.conversation ||
              m?.message?.extendedTextMessage?.text || ''
            ).toLowerCase()
            if (texto) {
              const depts = db.prepare('SELECT id,keywords FROM wa_departments WHERE tenant_id=? AND keywords!=\'\'').all(tid_wh)
              let matchDeptId = null
              for (const d of depts) {
                const kws = (d.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
                if (kws.some(k => k && texto.includes(k))) { matchDeptId = d.id; break }
              }
              if (matchDeptId) {
                try {
                  // Round-robin: busca atendente com menos convs neste dept
                  const atendentes = db.prepare(`
                    SELECT u.id,
                      (SELECT COUNT(*) FROM wa_conv_dept c WHERE c.atendente_id=u.id AND c.tenant_id=u.tenant_id) AS total
                    FROM sys_users u
                    WHERE u.tenant_id=? AND u.ativo=1 AND u.role='atendente' AND u.dept_id=?
                    ORDER BY total ASC, u.id ASC LIMIT 1
                  `).get(tid_wh, matchDeptId)
                  const atId = atendentes?.id || null
                  db.prepare(`INSERT INTO wa_conv_dept (tenant_id,jid,dept_id,atendente_id,assigned_at)
                    VALUES (?,?,?,?,datetime('now'))
                    ON CONFLICT(tenant_id,jid) DO UPDATE SET
                      dept_id=excluded.dept_id,
                      atendente_id=excluded.atendente_id,
                      assigned_at=excluded.assigned_at`
                  ).run(tid_wh, jid, matchDeptId, atId)
                  marcarDirty()
                  log('🏷️', `[DEPT] Conv ${jid} → dept ${matchDeptId} atendente ${atId || 'sem atendente'} (round-robin)`)
                } catch(e) { log('⚠️', '[DEPT] Erro ao atribuir dept/atendente:', e.message) }
              }
            }
          }
        }

        // Se gestor enviou mensagem pelo próprio WhatsApp → pausa a IA para este contato
        if (fromMe && tid_wh) {
          const phone = jid.replace('@s.whatsapp.net','').replace('@c.us','')
          if (phone) {
            const pausaKey = `pausa:${tid_wh}:${phone}`
            _pausaHumano.set(pausaKey, Date.now())
            log('👤', `[PAUSA] Gestor enviou via WA (webhook) — IA pausada para ${phone} [${tid_wh}]`)
          }
        }

        // SSE para mensagens RECEBIDAS (fromMe=false)
        if (!fromMe) {
          sseBroadcast(`wa-msgs:${tid_wh}`, 'wa:msg', m)
        }
      }

      // Limpa msgs com mais de 7 dias
      try {
        const cutoff = Math.floor(Date.now()/1000) - 7*24*3600
        db.prepare('DELETE FROM wa_messages WHERE tenant_id=? AND ts < ? AND ts > 0').run(tid_wh, cutoff)
      } catch(e) {}
    }

    // Processa IA (re-usa body já lido)
    const fakeReq = Object.assign(Object.create(req), { _parsedBody: body })
    await handleIAWebhook(fakeReq, res)
    return true
  }

  // ── Cache de mensagens WhatsApp — GET (carrega conversa) ──
  if (req.method === 'GET' && upath === '/api/wa/messages') {
    const tenantId = req.headers['x-tenant-id']
    const jid      = params.get('jid')
    if (!tenantId || !jid) { send(res, 400, { error: 'tenant e jid obrigatórios' }); return true }
    try {
      const rows = db.prepare(
        'SELECT payload FROM wa_messages WHERE tenant_id=? AND remote_jid=? ORDER BY ts ASC LIMIT 200'
      ).all(tenantId, jid)
      const msgs = rows.map(r => { try { return JSON.parse(r.payload) } catch { return null } }).filter(Boolean)
      send(res, 200, msgs)
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Cache de mensagens WhatsApp — POST (salva batch) ───
  if (req.method === 'POST' && upath === '/api/wa/messages') {
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId) { send(res, 401, { error: 'x-tenant-id obrigatório' }); return true }
    const body = await readBody(req)
    const msgs = Array.isArray(body) ? body : (body?.messages || [])
    if (!msgs.length) { send(res, 200, { saved: 0 }); return true }
    try {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO wa_messages (tenant_id, remote_jid, msg_id, payload, from_me, ts) VALUES (?,?,?,?,?,?)'
      )
      const insert = db.transaction(list => {
        let n = 0
        for (const m of list) {
          const jid   = m.key?.remoteJid
          const mid   = m.key?.id
          const fromMe = (m.key?.fromMe === true || m.key?.fromMe === 'true') ? 1 : 0
          const ts    = +m.messageTimestamp || 0
          if (!jid || !mid) continue
          try { stmt.run(tenantId, jid, mid, JSON.stringify(m), fromMe, ts); n++ } catch {}
        }
        return n
      })
      const saved = insert(msgs)
      // Limpa mensagens com mais de 7 dias para não crescer indefinidamente
      const cutoff = Math.floor(Date.now()/1000) - 7*24*3600
      db.prepare('DELETE FROM wa_messages WHERE tenant_id=? AND ts < ? AND ts > 0').run(tenantId, cutoff)
      marcarDirty()
      send(res, 200, { saved })
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }


  if (req.method === 'GET' && upath === '/api/wa/avatar') {
    const rawUrl = params.get('url')
    if (!rawUrl) { res.writeHead(204); res.end(); return true }
    try {
      const decoded = decodeURIComponent(rawUrl)
      const r = await fetch(decoded, {
        headers: { 'User-Agent': 'WhatsApp/2.2413.51 A' },
        signal:  AbortSignal.timeout(5000)
      })
      if (!r.ok) { res.writeHead(404); res.end(); return true }
      const buf = Buffer.from(await r.arrayBuffer())
      const ct  = r.headers.get('content-type') || 'image/jpeg'
      res.writeHead(200, {
        'Content-Type':  ct,
        'Cache-Control': 'public, max-age=7200',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(buf)
    } catch { res.writeHead(502); res.end() }
    return true
  }

  // ── Download de mídia WhatsApp (sob demanda) ─────────
  if (req.method === 'POST' && upath === '/api/wa/media') {
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId) { send(res, 401, { error: 'x-tenant-id obrigatório' }); return true }
    const body = await readBody(req)
    const { messageId, remoteJid } = body
    if (!messageId || !remoteJid) { send(res, 400, { error: 'messageId e remoteJid obrigatórios' }); return true }
    try {
      const cfg  = db.prepare('SELECT evo_instance FROM store_config WHERE tenant_id=?').get(tenantId)
      const inst = cfg?.evo_instance || EVO_INST
      if (!inst) { send(res, 400, { error: 'Instância não configurada' }); return true }

      // EVO 2.7: POST /chat/getBase64FromMediaMessage/{instance}
      const r = await fetch(`${EVO_URL}/chat/getBase64FromMediaMessage/${inst}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', apikey: EVO_KEY },
        body:    JSON.stringify({
          message:    { key: { id: messageId, remoteJid } },
          convertTo:  'base64',
          convertToMp4: false
        }),
        signal: AbortSignal.timeout(30000)
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) { send(res, r.status, { error: data?.message || 'Erro ao baixar mídia' }); return true }
      send(res, 200, {
        base64:   data.base64   || data.data   || null,
        mimetype: data.mimetype || data.mimeType || 'application/octet-stream',
        fileName: data.fileName || null
      })
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }


  // ── Clientes do gestor com stats calculados em tempo real ──
  if (req.method === 'GET' && upath === '/api/clientes-gestor') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    try {
      // Customers com stats calculados via JOIN com orders
      const customers = db.prepare(`
        SELECT
          c.id, c.name, c.phone, c.email, c.birthday, c.addr,
          c.created_at,
          COUNT(o.id)                       AS orders_count,
          COALESCE(SUM(o.total + o.taxa), 0) AS total_spent,
          MAX(o.created_at)                  AS last_order_at
        FROM customers c
        LEFT JOIN orders o ON o.tenant_id = c.tenant_id
          AND (o.customer_id = c.id OR o.phone = c.phone)
          AND o.status NOT IN ('cancelado', 'aguardando_pix')
        WHERE c.tenant_id = ?
        GROUP BY c.id
        ORDER BY c.created_at DESC
      `).all(tid)

      // Fidelidade por telefone (para pontos)
      const fid = db.prepare(
        'SELECT id, phone, pts, resgates FROM fidelidade WHERE tenant_id = ?'
      ).all(tid)
      const fidMap = {}
      fid.forEach(f => {
        const ph = (f.phone || '').replace(/\D/g, '').slice(-8)
        if (ph) fidMap[ph] = f
      })

      const result = customers.map(c => {
        const ph = (c.phone || '').replace(/\D/g, '').slice(-8)
        const f  = fidMap[ph] || null
        return {
          ...c,
          orders_count: c.orders_count || 0,
          total_spent:  parseFloat(c.total_spent || 0),
          last_order_at: c.last_order_at || null,
          fid_pts:  f ? (f.pts || 0) : null,
          fid_id:   f ? f.id : null
        }
      })

      send(res, 200, result)
    } catch (e) {
      log('❌', '/api/clientes-gestor erro:', e.message)
      send(res, 500, { error: e.message })
    }
    return true
  }

  // ══════════════════════════════════════════════════════
  // CARTÃO DE CRÉDITO — Mercado Pago
  // ══════════════════════════════════════════════════════

  // ── Retorna public_key para o frontend inicializar o SDK ──
  if (req.method === 'GET' && upath === '/api/cartao/public-key') {
    try {
      const row = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const cfg = row?.ia_config ? JSON.parse(row.ia_config) : {}
      const pk  = cfg.mp_public_key || ''
      if (!pk) { send(res, 200, { ok: false, public_key: '', cartao_ativo: false }); return true }
      send(res, 200, { ok: true, public_key: pk, cartao_ativo: true })
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Cria pagamento de cartão com card_token do SDK MP ──
  if (req.method === 'POST' && upath === '/api/cartao/criar') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    const body = await readBody(req)
    const { card_token, payment_method_id, valor, order_id, client, email = 'cliente@email.com', issuer_id } = body
    if (!card_token)         { send(res, 400, { error: 'card_token obrigatório' }); return true }
    if (!payment_method_id)  { send(res, 400, { error: 'payment_method_id obrigatório' }); return true }
    if (!valor || valor <= 0){ send(res, 400, { error: 'valor inválido' }); return true }

    // Busca token MP
    let mpToken = MP_TOKEN
    try {
      const c = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const g = c?.ia_config ? JSON.parse(c.ia_config) : {}
      if (g.mp_token) mpToken = g.mp_token
    } catch {}
    if (!mpToken) { send(res, 400, { error: 'Token Mercado Pago não configurado' }); return true }

    const extRef = `ef-card-${tid.slice(0,8)}-${order_id || Date.now()}`

    try {
      const mpBody = {
        transaction_amount: parseFloat(valor),
        token:              card_token,
        description:        `Pedido #${order_id || '?'} - ${client || 'Cliente'}`,
        installments:       1,
        payment_method_id,
        external_reference: extRef,
        payer: { email, first_name: client || 'Cliente', last_name: '' },
      }
      if (issuer_id) mpBody.issuer_id = issuer_id

      const mp = await fetch('https://api.mercadopago.com/v1/payments', {
        method:  'POST',
        headers: {
          'Content-Type':    'application/json',
          'Authorization':   `Bearer ${mpToken}`,
          'X-Idempotency-Key': extRef
        },
        body: JSON.stringify(mpBody)
      })
      const mpData = await mp.json()

      if (!mp.ok) {
        log('❌', 'MP Cartão erro:', mpData)
        send(res, 400, { error: mpData.message || 'Erro ao processar cartão', cause: mpData.cause || [] })
        return true
      }

      const statusMap = { approved: 'aprovado', rejected: 'rejeitado', cancelled: 'cancelado', in_process: 'em_processo', pending: 'pendente' }
      const novoStatus = statusMap[mpData.status] || 'pendente'
      const lastFour   = mpData.card?.last_four_digits || ''

      db.prepare(`INSERT OR IGNORE INTO pagamentos_cartao
        (tenant_id, order_id, mp_payment_id, mp_external_ref, valor, status, status_detail, payer_name, payer_email, last_four_digits, payment_method_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(tid, order_id || null, String(mpData.id), extRef, parseFloat(valor),
          novoStatus, mpData.status_detail || '', client || '', email, lastFour, payment_method_id)

      // Se aprovado, atualiza o pedido para 'analise'
      if (novoStatus === 'aprovado' && order_id) {
        db.prepare("UPDATE orders SET status='analise', pag='cartao_mp' WHERE id=? AND status='aguardando_cartao'").run(order_id)
        marcarDirty()
        const ord = db.prepare('SELECT * FROM orders WHERE id=?').get(order_id)
        if (ord) {
          const its = (() => { try { return JSON.parse(ord.items) } catch { return [] } })()
          sseBroadcast(`orders-rt:${tid}`, 'orders:UPDATE', { ...ord, items: its, status: 'analise', pag: 'cartao_mp' })
        }
      }

      log('💳', `Cartão ${novoStatus}: R$${valor} tenant=${tid} mp_id=${mpData.id} detail=${mpData.status_detail}`)
      send(res, 200, {
        ok:             novoStatus === 'aprovado',
        mp_payment_id:  mpData.id,
        status:         novoStatus,
        status_detail:  mpData.status_detail || '',
        last_four:      lastFour,
        payment_method: payment_method_id,
      })
    } catch(e) {
      log('❌', 'Cartão fetch erro:', e.message)
      send(res, 500, { error: 'Erro ao processar pagamento: ' + e.message })
    }
    return true
  }

  // ── Consulta status de pagamento de cartão ──
  if (req.method === 'GET' && upath === '/api/cartao/status') {
    const mpId = params.get('mp_payment_id') || ''
    if (!mpId) { send(res, 400, { error: 'mp_payment_id obrigatório' }); return true }
    const tid3 = req.headers['x-tenant-id'] || ''
    if (tid3) {
      const own3 = db.prepare('SELECT tenant_id FROM pagamentos_cartao WHERE mp_payment_id=?').get(String(mpId))
      if (own3 && own3.tenant_id !== tid3) { send(res, 403, { error: 'Acesso negado' }); return true }
    }
    let mpToken = MP_TOKEN
    try {
      const c = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const g = c?.ia_config ? JSON.parse(c.ia_config) : {}
      if (g.mp_token) mpToken = g.mp_token
    } catch {}
    if (!mpToken) { send(res, 400, { error: 'Token MP não configurado' }); return true }
    try {
      const r  = await fetch(`https://api.mercadopago.com/v1/payments/${mpId}`, { headers: { 'Authorization': `Bearer ${mpToken}` } })
      const pd = await r.json()
      const statusMap = { approved: 'aprovado', rejected: 'rejeitado', cancelled: 'cancelado', in_process: 'em_processo', pending: 'pendente' }
      const novoStatus = statusMap[pd.status] || 'pendente'
      // Atualiza banco
      db.prepare('UPDATE pagamentos_cartao SET status=?, status_detail=?, paid_at=? WHERE mp_payment_id=?')
        .run(novoStatus, pd.status_detail || '', pd.date_approved || null, String(mpId))
      send(res, 200, { status: novoStatus, status_detail: pd.status_detail || '', mp_status: pd.status })
    } catch(e) {
      const fb = db.prepare('SELECT status,status_detail FROM pagamentos_cartao WHERE mp_payment_id=?').get(String(mpId))
      send(res, 200, { status: fb?.status || 'pendente', status_detail: fb?.status_detail || '' })
    }
    return true
  }

  // ═══════════════════════════════════════════════════════
  // Planos & Renovacao
  // ═══════════════════════════════════════════════════════

  // ── Precos dos planos (publico) ──────────────────────
  if (req.method === 'GET' && upath === '/api/planos/precos') {
    try {
      const cfg = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const ia = cfg?.ia_config ? JSON.parse(cfg.ia_config) : {}
      send(res, 200, {
        essencial: ia.preco_essencial !== undefined ? parseFloat(ia.preco_essencial) : 79.99,
        premium: ia.preco_premium !== undefined ? parseFloat(ia.preco_premium) : 99.90
      })
    } catch(e) { send(res, 200, { essencial: 79.99, premium: 99.90 }) }
    return true
  }

  // ── Admin: Salvar precos dos planos ──────────────────
  if (req.method === 'POST' && upath === '/api/admin/planos/precos') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Nao autorizado' }); return true }
    const body = await readBody(req)
    const { preco_essencial, preco_premium } = body
    try {
      const cfg = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const ia = cfg?.ia_config ? JSON.parse(cfg.ia_config) : {}
      if (preco_essencial !== undefined) ia.preco_essencial = parseFloat(preco_essencial)
      if (preco_premium !== undefined) ia.preco_premium = parseFloat(preco_premium)
      db.prepare("INSERT INTO store_config (tenant_id,ia_config) VALUES ('_global',?) ON CONFLICT(tenant_id) DO UPDATE SET ia_config=excluded.ia_config").run(JSON.stringify(ia))
      marcarDirty()
      log('⚙️', `Precos planos atualizados: Essencial=R$${ia.preco_essencial} Premium=R$${ia.preco_premium}`)
      send(res, 200, { ok: true, preco_essencial: ia.preco_essencial, preco_premium: ia.preco_premium })
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Pagar plano via PIX ──────────────────────────────
  if (req.method === 'POST' && upath === '/api/planos/pagar-pix') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatorio' }); return true }
    const body = await readBody(req)
    const { plano, valor } = body
    if (!plano || !valor || valor <= 0) { send(res, 400, { error: 'Plano e valor obrigatorios' }); return true }

    let mpToken = MP_TOKEN
    try {
      const cfgMp = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const gCfg = cfgMp?.ia_config ? JSON.parse(cfgMp.ia_config) : {}
      if (gCfg.mp_token) mpToken = gCfg.mp_token
    } catch {}
    if (!mpToken) { send(res, 400, { error: 'Token Mercado Pago nao configurado.' }); return true }

    const tenant = db.prepare('SELECT nome FROM tenants WHERE id=?').get(tid)
    const extRef = `plano-${tid.slice(0,8)}-${plano}-${Date.now()}`

    try {
      const mp = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mpToken}`, 'X-Idempotency-Key': extRef },
        body: JSON.stringify({
          transaction_amount: parseFloat(valor),
          description: `Renovacao ${plano === 'premium' ? 'Plano Premium' : 'Plano Essencial'} - ${tenant?.nome || 'Cliente'}`,
          payment_method_id: 'pix',
          external_reference: extRef,
          payer: { email: 'renovacao@estimafood.com', first_name: tenant?.nome || 'Cliente', last_name: '' },
        })
      })
      const mpData = await mp.json()
      if (!mp.ok) { log('❌', 'MP PIX plano erro:', mpData); send(res, 400, { error: mpData.message || 'Erro MP' }); return true }

      const qr    = mpData.point_of_interaction?.transaction_data?.qr_code || ''
      const qrB64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64 || ''

      // Salva na tabela de pagamentos de plano apenas se o tenant existir (leads da landing usam ID temporario)
      const tenantExiste = db.prepare('SELECT id FROM tenants WHERE id=?').get(tid)
      if (tenantExiste) {
        try {
          db.prepare(`INSERT INTO pagamentos_pix (tenant_id,mp_payment_id,mp_external_ref,valor,taxa,valor_liquido,status,payer_name,qr_code,qr_code_base64)
            VALUES (?,?,?,?,0,?,?,?,?,?)`)
            .run(tid, String(mpData.id), extRef, parseFloat(valor), parseFloat(valor),
              (mpData.status==='approved'?'aprovado':'pendente'), `PLANO:${plano}`, qr, qrB64)
        } catch (dbErr) { log('⚠️', `PIX plano: nao foi possivel salvar no BD tenant=${tid}:`, dbErr.message) }
      } else {
        log('ℹ️', `PIX plano criado para lead externo (sem tenant): mp_id=${mpData.id} plano=${plano}`)
      }

      log('💳', `PIX plano criado: R$${valor} plano=${plano} tenant=${tid} mp_id=${mpData.id}`)
      send(res, 200, { ok: true, mp_payment_id: mpData.id, qr_code: qr, qr_code_base64: qrB64, valor, status: mpData.status })
    } catch (e) { log('❌', 'MP plano fetch erro:', { error: e.message }); send(res, 500, { error: 'Erro ao criar PIX: ' + e.message }) }
    return true
  }

  // ── Status PIX plano ─────────────────────────────────
  if (req.method === 'GET' && upath === '/api/planos/status-pix') {
    const mpId = params.get('mp_payment_id') || ''
    if (!mpId) { send(res, 400, { error: 'mp_payment_id obrigatorio' }); return true }
    let mpToken = MP_TOKEN
    try { const c = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get(); const g = c?.ia_config ? JSON.parse(c.ia_config) : {}; if (g.mp_token) mpToken = g.mp_token } catch {}
    if (!mpToken) { send(res, 400, { error: 'Token MP nao configurado' }); return true }
    try {
      const r = await fetch('https://api.mercadopago.com/v1/payments/' + mpId, { headers: { 'Authorization': 'Bearer ' + mpToken } })
      const pd = await r.json()
      if (!r.ok) { const fb = db.prepare('SELECT status FROM pagamentos_pix WHERE mp_payment_id=?').get(String(mpId)); send(res, 200, { status: fb ? fb.status : 'pendente' }); return true }
      const novoStatus = pd.status === 'approved' ? 'aprovado' : pd.status === 'rejected' ? 'rejeitado' : pd.status === 'cancelled' ? 'cancelado' : 'pendente'
      const rowAtual = db.prepare('SELECT status,valor,tenant_id,payer_name FROM pagamentos_pix WHERE mp_payment_id=?').get(String(mpId))
      if (rowAtual && rowAtual.status !== novoStatus) {
        db.prepare('UPDATE pagamentos_pix SET status=?,paid_at=? WHERE mp_payment_id=?').run(novoStatus, pd.date_approved || null, String(mpId))
        if (novoStatus === 'aprovado' && rowAtual.payer_name?.startsWith('PLANO:')) {
          // Renovar o plano do tenant
          const plano = rowAtual.payer_name.replace('PLANO:', '')
          const novaExpira = new Date()
          novaExpira.setDate(novaExpira.getDate() + 30)
          db.prepare('UPDATE tenants SET plano=?, expires_at=?, ativo=1 WHERE id=?').run(plano, novaExpira.toISOString().slice(0,10), rowAtual.tenant_id)
          marcarDirty()
          log('✅', `PLANO RENOVADO: ${plano} tenant=${rowAtual.tenant_id} expira=${novaExpira.toISOString().slice(0,10)}`)
        }
      }
      send(res, 200, { status: novoStatus, mp_status: pd.status })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Pagar plano via Cartao (usando card_token do SDK MP) ──
  if (req.method === 'POST' && upath === '/api/planos/pagar-cartao') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatorio' }); return true }
    const body = await readBody(req)
    const { plano, valor, card_token, payment_method_id, payer_email, payer_cpf } = body
    if (!plano || !valor) { send(res, 400, { error: 'Plano e valor obrigatorios' }); return true }
    if (!card_token) { send(res, 400, { error: 'card_token obrigatorio' }); return true }
    if (!payment_method_id) { send(res, 400, { error: 'payment_method_id obrigatorio' }); return true }

    let mpToken = MP_TOKEN
    try {
      const cfgMp = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const gCfg = cfgMp?.ia_config ? JSON.parse(cfgMp.ia_config) : {}
      if (gCfg.mp_token) mpToken = gCfg.mp_token
    } catch {}
    if (!mpToken) { send(res, 400, { error: 'Token Mercado Pago nao configurado.' }); return true }

    const tenant = db.prepare('SELECT nome FROM tenants WHERE id=?').get(tid)
    const extRef = `plano-cartao-${tid.slice(0,8)}-${plano}-${Date.now()}`

    try {
      const mp = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mpToken}`, 'X-Idempotency-Key': extRef },
        body: JSON.stringify({
          transaction_amount: parseFloat(valor),
          token: card_token,
          description: `Renovacao ${plano === 'premium' ? 'Plano Premium' : 'Plano Essencial'} - ${tenant?.nome || 'Cliente'}`,
          installments: 1,
          payment_method_id,
          external_reference: extRef,
          payer: {
            email: payer_email || 'renovacao@estimafood.com',
            identification: { type: 'CPF', number: (payer_cpf || '').replace(/\D/g,'') }
          }
        })
      })
      const mpData = await mp.json()
      if (!mp.ok) {
        log('❌', 'MP Cartao plano erro:', mpData)
        send(res, 400, { error: mpData.message || mpData.cause?.[0]?.description || 'Erro no pagamento' })
        return true
      }

      const novoStatus = mpData.status === 'approved' ? 'aprovado' : mpData.status === 'rejected' ? 'rejeitado' : 'pendente'

      // Salva pagamento
      db.prepare(`INSERT INTO pagamentos_cartao (tenant_id,mp_payment_id,mp_external_ref,valor,status,status_detail,payer_name,payment_method_id)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(tid, String(mpData.id), extRef, parseFloat(valor), novoStatus, mpData.status_detail || '', `PLANO:${plano}`, mpData.payment_method_id || '')

      // Se aprovado, renova o plano
      if (novoStatus === 'aprovado') {
        const novaExpira = new Date()
        novaExpira.setDate(novaExpira.getDate() + 30)
        db.prepare('UPDATE tenants SET plano=?, expires_at=?, ativo=1 WHERE id=?').run(plano, novaExpira.toISOString().slice(0,10), tid)
        marcarDirty()
        log('✅', `PLANO RENOVADO (Cartao): ${plano} tenant=${tid} expira=${novaExpira.toISOString().slice(0,10)}`)
      }

      log('💳', `Cartao plano: R$${valor} plano=${plano} tenant=${tid} status=${novoStatus}`)
      send(res, 200, { ok: true, status: novoStatus, status_detail: mpData.status_detail || '' })
    } catch (e) { log('❌', 'Cartao plano erro:', { error: e.message }); send(res, 500, { error: 'Erro ao processar pagamento: ' + e.message }) }
    return true
  }
  
  // ── Obter Public Key MP para frontend ────────────────
  if (req.method === 'GET' && upath === '/api/planos/mp-public-key') {
    try {
      const cfgMp = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const gCfg = cfgMp?.ia_config ? JSON.parse(cfgMp.ia_config) : {}
      send(res, 200, { public_key: gCfg.mp_public_key || '' })
    } catch { send(res, 200, { public_key: '' }) }
    return true
  }

  // ── Solicitar teste gratis (landing page → WA admin) ─────────────
  if (req.method === 'POST' && upath === '/api/planos/solicitar-teste') {
    const body = await readBody(req)
    const { nome, restaurante, telefone, cidade, plano } = body
    if (!nome || !telefone) { send(res, 400, { error: 'Nome e telefone obrigatorios' }); return true }
    try {
      // Busca numero do admin no config global
      const cfgG = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const gCfg = cfgG?.ia_config ? JSON.parse(cfgG.ia_config) : {}
      const adminPhone = (gCfg.admin_phone || '').replace(/\D/g,'')
      const planoLabel = plano === 'premium' ? 'Premium' : 'Essencial'
      const msgAdmin = [
        `*🆕 NOVO LEAD — TESTE GRATIS*`,
        ``,
        `*Nome:* ${nome}`,
        `*Restaurante:* ${restaurante || '—'}`,
        `*Telefone:* ${telefone}`,
        `*Cidade:* ${cidade || '—'}`,
        `*Plano de interesse:* ${planoLabel}`,
        ``,
        `_Enviado automaticamente pela landing page_`
      ].join('\n')
      // Envia WA para admin
      if (adminPhone) {
        try {
          const evoHeaders = { 'Content-Type': 'application/json', apikey: EVO_KEY }
          const evoBody = JSON.stringify({ number: adminPhone, text: msgAdmin })
          await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, { method: 'POST', headers: evoHeaders, body: evoBody })
          log('📨', `Trial lead WA enviado para admin (${adminPhone}): ${nome} — ${planoLabel}`)
        } catch(eWa) { log('⚠️', 'WA admin trial erro:', eWa.message) }
      } else {
        log('⚠️', 'admin_phone nao configurado no painel admin — WA nao enviado')
      }
      // Salva lead na tabela (cria se nao existir)
      try {
        db.prepare(`CREATE TABLE IF NOT EXISTS leads_trial (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nome TEXT, restaurante TEXT, telefone TEXT, cidade TEXT, plano TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`).run()
        db.prepare('INSERT INTO leads_trial (nome,restaurante,telefone,cidade,plano) VALUES (?,?,?,?,?)').run(
          nome, restaurante||'', telefone, cidade||'', plano||'essencial'
        )
      } catch(eDb) { log('⚠️', 'leads_trial insert erro:', eDb.message) }
      send(res, 200, { ok: true })
    } catch(e) { log('❌', 'solicitar-teste erro:', e.message); send(res, 500, { error: e.message }) }
    return true
  }

  // ── Admin: Configurar telefone admin (WA para receber leads) ──────
  if (req.method === 'POST' && upath === '/api/admin/planos/admin-phone') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Nao autorizado' }); return true }
    const body = await readBody(req)
    const { admin_phone } = body
    try {
      const cfgG = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const ia = cfgG?.ia_config ? JSON.parse(cfgG.ia_config) : {}
      ia.admin_phone = (admin_phone || '').replace(/\D/g,'')
      db.prepare("INSERT INTO store_config (tenant_id,ia_config) VALUES ('_global',?) ON CONFLICT(tenant_id) DO UPDATE SET ia_config=excluded.ia_config").run(JSON.stringify(ia))
      marcarDirty()
      log('⚙️', `admin_phone configurado: ${ia.admin_phone}`)
      send(res, 200, { ok: true, admin_phone: ia.admin_phone })
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Admin: Obter telefone admin ────────────────────────────────────
  if (req.method === 'GET' && upath === '/api/admin/planos/admin-phone') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Nao autorizado' }); return true }
    try {
      const cfgG = db.prepare("SELECT ia_config FROM store_config WHERE tenant_id='_global'").get()
      const ia = cfgG?.ia_config ? JSON.parse(cfgG.ia_config) : {}
      send(res, 200, { admin_phone: ia.admin_phone || '' })
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Admin: Listar leads trial ──────────────────────────────────────
  if (req.method === 'GET' && upath === '/api/admin/leads-trial') {
    if (!validarSessaoAdmin(req)) { send(res, 401, { error: 'Nao autorizado' }); return true }
    try {
      db.prepare(`CREATE TABLE IF NOT EXISTS leads_trial (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT, restaurante TEXT, telefone TEXT, cidade TEXT, plano TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`).run()
      const leads = db.prepare('SELECT * FROM leads_trial ORDER BY created_at DESC LIMIT 200').all()
      send(res, 200, leads)
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Segmento do tenant ──────────────────────────────────────────────────
  if (upath === '/api/tenant-segmento') {
    const tid = req.headers['x-tenant-id'] || params.get('tenant_id') || ''
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    if (req.method === 'GET') {
      const row = db.prepare('SELECT segmento FROM tenants WHERE id=?').get(tid)
      send(res, 200, { segmento: row?.segmento || 'restaurante' }); return true
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req)
      const seg  = ['restaurante','acougue'].includes(body.segmento) ? body.segmento : 'restaurante'
      db.prepare('UPDATE tenants SET segmento=? WHERE id=?').run(seg, tid)
      marcarDirty()
      send(res, 200, { ok: true, segmento: seg }); return true
    }
  }

  // ── Catálogos do Açougue (cortes, preparos, ocasiao, armazenamento) ────────
  if (upath === '/api/acougue-catalogs') {
    const tid = req.headers['x-tenant-id'] || params.get('tenant_id') || ''
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }

    if (req.method === 'GET') {
      const row = db.prepare('SELECT ia_config FROM store_config WHERE tenant_id=?').get(tid)
      const ia  = row?.ia_config ? JSON.parse(row.ia_config) : {}
      send(res, 200, { catalogs: ia.acougue_catalogs || null }); return true
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object') { send(res, 400, { error: 'Body inválido' }); return true }
      const row = db.prepare('SELECT ia_config FROM store_config WHERE tenant_id=?').get(tid)
      const ia  = row?.ia_config ? JSON.parse(row.ia_config) : {}
      ia.acougue_catalogs = body
      db.prepare('INSERT INTO store_config (tenant_id,ia_config) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET ia_config=excluded.ia_config')
        .run(tid, JSON.stringify(ia))
      marcarDirty()
      send(res, 200, { ok: true }); return true
    }
  }
  if (req.method === 'POST' && upath === '/api/garcom-login') {
    const tid  = getTenantId(req, params)
    const body = await readBody(req)
    const { usuario, senha } = body
    if (!usuario || !senha) { send(res, 400, { error: 'Usuário e senha obrigatórios' }); return true }
    if (!tid)               { send(res, 400, { error: 'Tenant não identificado' }); return true }
    try {
      const g = db.prepare(
        'SELECT id, tenant_id, nome, usuario, ativo FROM garcons WHERE tenant_id=? AND usuario=? AND senha=? AND ativo=1'
      ).get(tid, usuario.trim().toLowerCase(), senha)
      if (!g) { send(res, 401, { error: 'Usuário ou senha incorretos' }); return true }
      send(res, 200, { id: g.id, tenant_id: g.tenant_id, nome: g.nome, usuario: g.usuario, ativo: true })
    } catch(e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Gera PDF de um job e devolve base64 (para extensão Chrome) ──
  if (req.method === 'GET' && upath.startsWith('/api/print-queue/pdf/')) {
    const tid   = req.headers['x-tenant-id']
    const jobId = parseInt(upath.split('/')[4]) || 0
    if (!tid || !jobId) { send(res, 400, { error: 'parâmetros inválidos' }); return true }
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS print_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, html TEXT NOT NULL,
        format TEXT DEFAULT 'A4', printer TEXT,
        status TEXT DEFAULT 'pending', error TEXT,
        created_at TEXT DEFAULT (datetime('now')), done_at TEXT
      )`)
      const job = db.prepare(
        `SELECT id, html, format, printer FROM print_jobs WHERE id=? AND tenant_id=?`
      ).get(jobId, tid)
      if (!job) { send(res, 404, { error: 'Job não encontrado' }); return true }

      let puppeteer
      try { puppeteer = require('puppeteer') } catch {
        send(res, 500, { error: 'Puppeteer não instalado' }); return true
      }

      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
      })
      let pdfBase64
      try {
        const page = await browser.newPage()
        const fullHtml = job.html.includes('<html') ? job.html
          : `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { font-family:'Courier New',monospace; font-size:12px; color:#000; background:#fff }
  hr { border:none; border-top:1px dashed #000; margin:4px 0 }
  .pt-center { text-align:center } .pt-large { font-size:15px; font-weight:bold }
  .pt-hr { border:none; border-top:1px dashed #000; margin:4px 0 }
  .print-ticket { padding:4px; width:100% }
</style></head><body>${job.html}</body></html>`
        await page.setContent(fullHtml, { waitUntil: 'networkidle0' })
        const pdfOpts = {
          printBackground: true,
          margin: { top:'4mm', bottom:'4mm', left:'4mm', right:'4mm' }
        }
        const fmt = job.format || 'A4'
        if (fmt === '80mm' || fmt === '58mm') {
          pdfOpts.width  = fmt
          pdfOpts.height = (await page.evaluate(() => document.body.scrollHeight + 20)) + 'px'
        } else {
          pdfOpts.format = fmt
        }
        const pdfBuf = await page.pdf(pdfOpts)
        pdfBase64 = pdfBuf.toString('base64')
      } finally {
        await browser.close()
      }
      send(res, 200, {
        ok: true,
        id: job.id,
        pdf: pdfBase64,
        format: job.format || 'A4',
        printer: job.printer || ''
      })
    } catch (e) {
      log('❌', 'PDF para extensão erro:', e.message)
      send(res, 500, { error: e.message })
    }
    return true
  }

  // ═══════════════════════════════════════════════════════
  // FILA DE IMPRESSÃO — Agente local
  // O agente roda no computador da loja e consulta esta fila
  // ═══════════════════════════════════════════════════════

  // ── Lista impressoras do sistema ──────────────────────────────────
  if (req.method === 'GET' && upath === '/api/printers') {
    log('🖨️', '[PRINT] GET /api/printers | plataforma:', process.platform)
    try {
      const { execSync } = require('child_process')
      let printers = []
      let defaultPrinter = ''
      try {
        if (process.platform === 'win32') {
          const out = execSync('powershell -Command "Get-Printer | Select-Object Name,Default | ConvertTo-Json"', { timeout: 5000 }).toString()
          const list = JSON.parse(out)
          const arr = Array.isArray(list) ? list : [list]
          printers       = arr.map(p => p.Name)
          defaultPrinter = (arr.find(p => p.Default) || {}).Name || ''
        } else {
          const out = execSync('lpstat -a 2>/dev/null || lpstat -p 2>/dev/null', { timeout: 5000 }).toString()
          printers = out.split('\n').filter(Boolean).map(l => l.split(' ')[0] || l.split('\t')[0]).filter(Boolean)
          try { defaultPrinter = execSync('lpstat -d 2>/dev/null', { timeout: 3000 }).toString().split(':')[1]?.trim() || '' } catch {}
        }
      } catch (e) {
        log('⚠️', '[PRINT] Erro ao listar impressoras:', e.message)
      }
      log('🖨️', '[PRINT] Impressoras encontradas:', printers.length, '| padrão:', defaultPrinter || '(nenhuma)')
      send(res, 200, { printers, default: defaultPrinter })
    } catch (e) {
      log('❌', '[PRINT] /api/printers erro:', e.message)
      send(res, 200, { printers: [], default: '' })
    }
    return true
  }

  // ── Gera PDF no servidor e devolve como base64 para o navegador imprimir ──
  if (req.method === 'POST' && upath === '/api/print') {
    const tid  = req.headers['x-tenant-id']
    const body = await readBody(req)
    log('🖨️', '[PRINT] POST /api/print | tenant:', tid || '(sem tenant)' , '| format:', body.format || '80mm', '| html length:', body.html?.length || 0)

    if (!tid)       { log('❌','[PRINT] Rejeitado: sem x-tenant-id'); send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    if (!body.html) { log('❌','[PRINT] Rejeitado: sem html');         send(res, 400, { error: 'html obrigatório' });         return true }

    try {
      let puppeteer
      try {
        puppeteer = require('puppeteer')
        log('🖨️', '[PRINT] Puppeteer carregado OK')
      } catch (e) {
        log('❌', '[PRINT] Puppeteer não instalado:', e.message)
        send(res, 500, { error: 'Puppeteer não instalado no servidor' }); return true
      }

      log('🖨️', '[PRINT] Iniciando browser...')
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
      })
      log('🖨️', '[PRINT] Browser iniciado')

      let pdfBase64
      try {
        const page = await browser.newPage()
        const fmt  = body.format || '80mm'
        const fullHtml = body.html.includes('<html') ? body.html
          : `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { font-family:'Courier New',monospace; font-size:12px; color:#000; background:#fff }
  hr { border:none; border-top:1px dashed #000; margin:4px 0 }
  .pt-center { text-align:center } .pt-large { font-size:15px; font-weight:bold }
  .pt-hr { border:none; border-top:1px dashed #000; margin:4px 0 }
  .print-ticket { padding:4px; width:100% }
</style></head><body>${body.html}</body></html>`

        await page.setContent(fullHtml, { waitUntil: 'networkidle0' })
        log('🖨️', '[PRINT] Página renderizada | formato:', fmt)

        const pdfOpts = {
          printBackground: true,
          margin: { top:'2mm', bottom:'2mm', left:'2mm', right:'2mm' }
        }
        if (fmt === '80mm' || fmt === '58mm') {
          pdfOpts.width  = fmt
          pdfOpts.height = (await page.evaluate(() => document.body.scrollHeight + 24)) + 'px'
        } else {
          pdfOpts.format = fmt
        }
        const pdfBuf = await page.pdf(pdfOpts)
        pdfBase64 = pdfBuf.toString('base64')
        log('✅', '[PRINT] PDF gerado | tamanho:', Math.round(pdfBuf.length / 1024) + 'KB')
      } finally {
        await browser.close()
        log('🖨️', '[PRINT] Browser fechado')
      }

      send(res, 200, { ok: true, pdf: pdfBase64 })
      log('✅', '[PRINT] PDF enviado ao navegador com sucesso')
    } catch (e) {
      log('❌', '[PRINT] /api/print erro:', e.message)
      log('❌', '[PRINT] Stack:', e.stack?.split('\n')[1] || '')
      send(res, 500, { error: e.message })
    }
    return true
  }

  // Mapa em memória: tenant_id → { last_seen, printer, format }
  if (!handleRoutes._agents) handleRoutes._agents = new Map()
  const _agents = handleRoutes._agents

  // ── Heartbeat do agente (a cada 10s) ─────────────────
  if (req.method === 'POST' && upath === '/api/print-queue/heartbeat') {
    const tid  = req.headers['x-tenant-id']
    const body = await readBody(req)
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    _agents.set(tid, { last_seen: Date.now(), printer: body.printer || '', format: body.format || 'A4' })
    send(res, 200, { ok: true })
    return true
  }

  // ── Status do agente (gestor consulta antes de criar job) ──
  if (req.method === 'GET' && upath === '/api/print-queue/status') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    const agent = _agents.get(tid)
    const active = agent && (Date.now() - agent.last_seen) < 30000
    send(res, 200, { active: !!active, printer: agent?.printer || '', format: agent?.format || 'A4' })
    return true
  }

  // ── Gestor cria job na fila ───────────────────────────
  if (req.method === 'POST' && upath === '/api/print-queue/job') {
    const tid  = req.headers['x-tenant-id']
    const body = await readBody(req)
    if (!tid)       { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    if (!body.html) { send(res, 400, { error: 'html obrigatório' }); return true }
    try {
      // Garante que a tabela existe (com coluna tipo para roteamento caixa/cozinha)
      db.exec(`CREATE TABLE IF NOT EXISTS print_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, html TEXT NOT NULL,
        format TEXT DEFAULT 'A4', printer TEXT,
        tipo TEXT DEFAULT NULL,
        status TEXT DEFAULT 'pending', error TEXT,
        created_at TEXT DEFAULT (datetime('now')), done_at TEXT
      )`)
      // Migration: adiciona coluna tipo se não existir (para DBs já criados)
      try { db.exec(`ALTER TABLE print_jobs ADD COLUMN tipo TEXT DEFAULT NULL`) } catch (_) {}
      const info = db.prepare(
        `INSERT INTO print_jobs (tenant_id, html, format, printer, tipo) VALUES (?, ?, ?, ?, ?)`
      ).run(tid, body.html, body.format || 'A4', body.printer || null, body.tipo || null)
      send(res, 201, { ok: true, id: info.lastInsertRowid })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Agente busca jobs pendentes ───────────────────────
  if (req.method === 'GET' && upath === '/api/print-queue/pending') {
    const tid = req.headers['x-tenant-id']
    if (!tid) { send(res, 400, { error: 'x-tenant-id obrigatório' }); return true }
    // Filtro opcional por tipo (caixa, cozinha) via query string ?tipo=caixa
    const parsedUrl = new URL(req.url, 'http://localhost')
    const tipoFilter = parsedUrl.searchParams.get('tipo') || null
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS print_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, html TEXT NOT NULL,
        format TEXT DEFAULT 'A4', printer TEXT,
        tipo TEXT DEFAULT NULL,
        status TEXT DEFAULT 'pending', error TEXT,
        created_at TEXT DEFAULT (datetime('now')), done_at TEXT
      )`)
      try { db.exec(`ALTER TABLE print_jobs ADD COLUMN tipo TEXT DEFAULT NULL`) } catch (_) {}
      let jobs
      if (tipoFilter) {
        jobs = db.prepare(
          `SELECT id, html, format, printer, tipo FROM print_jobs WHERE tenant_id=? AND status='pending' AND tipo=? ORDER BY id ASC LIMIT 5`
        ).all(tid, tipoFilter)
      } else {
        jobs = db.prepare(
          `SELECT id, html, format, printer, tipo FROM print_jobs WHERE tenant_id=? AND status='pending' ORDER BY id ASC LIMIT 5`
        ).all(tid)
      }
      // Marca como 'processing' para não duplicar
      if (jobs.length) {
        const ids = jobs.map(j => j.id).join(',')
        db.exec(`UPDATE print_jobs SET status='processing' WHERE id IN (${ids})`)
      }
      send(res, 200, jobs)
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Agente marca job como concluído ou erro ───────────
  if (req.method === 'PATCH' && upath.startsWith('/api/print-queue/job/') && upath.endsWith('/done')) {
    const tid   = req.headers['x-tenant-id']
    const id    = parseInt(upath.split('/')[4]) || 0
    const body  = await readBody(req)
    if (!tid || !id) { send(res, 400, { error: 'parâmetros inválidos' }); return true }
    try {
      const status = body.status === 'error' ? 'error' : 'done'
      db.prepare(
        `UPDATE print_jobs SET status=?, error=?, done_at=datetime('now') WHERE id=? AND tenant_id=?`
      ).run(status, body.error || null, id, tid)
      // Limpa jobs antigos (>24h)
      db.exec(`DELETE FROM print_jobs WHERE created_at < datetime('now','-1 day')`)
      send(res, 200, { ok: true })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }

  // ── Max global ID para cálculo de offset por tenant ──
  if (req.method === 'GET' && upath === '/api/orders/global-max-id') {
    try {
      const row = db.prepare('SELECT COALESCE(MAX(id),0) as max_id FROM orders').get()
      send(res, 200, { max_id: row?.max_id || 0 })
    } catch (e) { send(res, 500, { error: e.message }) }
    return true
  }


  // ── Import cardápio em lote (transação única) ─────────────────────────
  if (req.method === 'POST' && upath === '/api/importar-cardapio') {
    const tid = req.headers['x-tenant-id'] || params.get('tenant_id') || ''
    if (!tid) { send(res, 401, { error: 'Não autorizado' }); return true }
    try {
      const body = await readBody(req)
      const categorias = body?.categorias
      if (!Array.isArray(categorias)) { send(res, 400, { error: 'categorias[] obrigatório' }); return true }

      const JSON_FIELDS_MI = new Set(['days','ingredients','custom_groups'])
      const COLS_MI = ['tenant_id','name','description','price','price_old','cat','cat_key','emoji',
                       'item_type','allow_half','max_flavors','promo','destaque','status',
                       'days','ingredients','custom_groups','sort_order']
      const COLS_CAT = ['tenant_id','name','label','type','promo','sort_order']

      let catsCriadas = 0, itensCriados = 0, erros = 0
      const catIds = {}  // name → id

      const doImport = db.transaction(() => {
        let catOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as mx FROM categories WHERE tenant_id=?').get(tid)?.mx || 0

        for (const catDef of categorias) {
          if (!catDef.name || !catDef.label) { erros++; continue }
          try {
            const catRow = {
              tenant_id: tid, name: catDef.name, label: catDef.label,
              type: catDef.type || 'Itens principais',
              promo: catDef.promo ? 1 : 0,
              sort_order: ++catOrder
            }
            const catKeys = Object.keys(catRow).filter(k => COLS_CAT.includes(k))
            const catInfo = db.prepare(
              `INSERT INTO categories (${catKeys.map(k=>`"${k}"`).join(',')}) VALUES (${catKeys.map(()=>'?').join(',')})`
            ).run(...catKeys.map(k => catRow[k]))
            catIds[catDef.name] = catInfo.lastInsertRowid
            catsCriadas++

            let itemOrder = 0
            for (const itemDef of (catDef.itens || [])) {
              if (!itemDef.name) { erros++; continue }
              try {
                const serialize = v => {
                  if (v === undefined || v === null) return null
                  if (v === true) return 1; if (v === false) return 0
                  if (Array.isArray(v) || (typeof v === 'object')) return JSON.stringify(v)
                  return v
                }
                const itemRow = {
                  tenant_id: tid,
                  name: itemDef.name,
                  description: itemDef.description || '',
                  price: parseFloat(itemDef.price) || 0,
                  price_old: itemDef.price_old || null,
                  cat: catDef.label,
                  cat_key: catDef.name,
                  emoji: itemDef.emoji || '🍽️',
                  item_type: itemDef.item_type || 'normal',
                  allow_half: itemDef.allow_half ? 1 : 0,
                  max_flavors: itemDef.max_flavors || 1,
                  promo: 0, destaque: 0,
                  status: itemDef.status || 'active',
                  days: JSON.stringify(itemDef.days || [1,1,1,1,1,1,1]),
                  ingredients: JSON.stringify(itemDef.ingredients || []),
                  custom_groups: JSON.stringify(itemDef.custom_groups || []),
                  sort_order: ++itemOrder
                }
                const itemKeys = Object.keys(itemRow).filter(k => COLS_MI.includes(k))
                db.prepare(
                  `INSERT INTO menu_items (${itemKeys.map(k=>`"${k}"`).join(',')}) VALUES (${itemKeys.map(()=>'?').join(',')})`
                ).run(...itemKeys.map(k => itemRow[k]))
                itensCriados++
              } catch(e) { erros++ }
            }
          } catch(e) { erros++ }
        }
      })

      doImport()
      marcarDirty()
      send(res, 200, { ok: true, catsCriadas, itensCriados, erros })
    } catch(e) {
      send(res, 500, { error: e.message })
    }
    return true
  }

  return false // nenhuma rota tratada aqui — passa para o REST engine
}
