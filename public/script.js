// Adaptador de persistência: mantém a interface do PDV e grava os dados no servidor SQLite.
  window.storage = {
    async get(chave){
      const resposta = await fetch('/api/storage/' + encodeURIComponent(chave));
      if(!resposta.ok) throw new Error('Não foi possível carregar os dados.');
      const dados = await resposta.json();
      return dados.value == null ? null : dados;
    },
    async set(chave, valor){
      const resposta = await fetch('/api/storage/' + encodeURIComponent(chave), {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({valor})
      });
      if(!resposta.ok) throw new Error('Não foi possível salvar os dados.');
      return resposta.json();
    }
  };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const VALOR_CAIXA_PADRAO = 50;
const ESTOQUE_TROCO_PADRAO = 200;

function normalizarCaixaPadrao(caixa = {}){
  const padrao = {
    aberto: false,
    saldoInicial: VALOR_CAIXA_PADRAO,
    saldoFinal: VALOR_CAIXA_PADRAO,
    trocoInicial: VALOR_CAIXA_PADRAO,
    estoqueTroco: ESTOQUE_TROCO_PADRAO,
    movimentacoes: []
  };
  const preenchido = { ...padrao, ...caixa };
  const lerNumero = (valor, fallback) => {
    const numero = Number(valor);
    return Number.isFinite(numero) && numero >= 0 && numero > 0 ? numero : fallback;
  };
  preenchido.trocoInicial = lerNumero(preenchido.trocoInicial, VALOR_CAIXA_PADRAO);
  preenchido.estoqueTroco = lerNumero(preenchido.estoqueTroco, ESTOQUE_TROCO_PADRAO);
  preenchido.saldoInicial = lerNumero(preenchido.saldoInicial, VALOR_CAIXA_PADRAO);
  preenchido.saldoFinal = lerNumero(preenchido.saldoFinal, preenchido.saldoInicial);
  if(!Array.isArray(preenchido.movimentacoes)) preenchido.movimentacoes = [];
  return preenchido;
}

/* ---------------- Estado ---------------- */
let state = {
  produtos: [], clientes: [], vendas: [], boletos: [], cart: [], vendedores: [], notasImportadas: [],
  vendedorLogado: null, clienteSelecionadoId: null,
  pagamento: 'Dinheiro', pagamentoDetalhe: null, parcelas: 1, tipoJuros: 'sem', pagamentoConfirmado: false,
  configPagamentos: { qrPix:'', qrPicPay:'' },
  caixa: normalizarCaixaPadrao(),
  loaded: false
};
let ultimaSincronizacaoRemota = null;

const fmt = (v) => 'R$ ' + v.toFixed(2).replace('.', ',');

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(()=> t.classList.remove('show'), 2200);
}

function aplicarAtalhosTeclado(){
  document.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const textoAtivo = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'F2') {
      e.preventDefault();
      const scanner = document.getElementById('scannerInput');
      if (scanner) { scanner.focus(); if (typeof scanner.select === 'function') scanner.select(); }
      return;
    }

    if (e.key === 'F3') {
      e.preventDefault();
      const busca = document.getElementById('buscaProduto');
      if (busca) { busca.focus(); if (typeof busca.select === 'function') busca.select(); }
      return;
    }

    if (e.key === 'F4') {
      e.preventDefault();
      const cliente = document.getElementById('clienteBusca');
      if (cliente) { cliente.focus(); if (typeof cliente.select === 'function') cliente.select(); }
      return;
    }

    if (e.key === 'F5') {
      if (!textoAtivo) {
        e.preventDefault();
        const btn = document.getElementById('finalizarBtn');
        if (btn) btn.click();
      }
      return;
    }

    if (e.key === 'F6') {
      if (!textoAtivo) {
        e.preventDefault();
        state.cart = [];
        renderCart();
        toast('Carrinho limpo.');
      }
      return;
    }

    if (e.key === 'Escape') {
      const modais = [
        'pesoModal', 'qrPagamentoModal', 'recebimentoModal', 'boletoModal',
        'reverterNotaModal', 'cancelarVendaModal', 'abrirCaixaModal',
        'confirmarFechamentoCaixaModal', 'fechamentoResumoCaixaModal',
        'excluirProdutoModal', 'comprovanteModal', 'xmlPreviewModal'
      ];
      for (const id of modais) {
        const modal = document.getElementById(id);
        if (modal && modal.classList.contains('show')) {
          modal.classList.remove('show');
          e.preventDefault();
          return;
        }
      }
    }
  });
}

/* ---------------- Visual 3D / Liquid Glass ---------------- */
function aplicarEfeito3D(ativo){
  const habilitado = Boolean(ativo);
  document.documentElement.setAttribute('data-efeito-3d', String(habilitado));
  const btn = document.getElementById('efeito3dToggleBtn');
  if (btn) {
    btn.textContent = habilitado ? 'Desativar efeito 3D' : 'Ativar efeito 3D';
    btn.setAttribute('aria-pressed', String(habilitado));
  }
}

async function initEfeito3D(){
  let ativo = true;
  try {
    const r = await window.storage.get('efeito3d');
    if (r && typeof r.value !== 'undefined') {
      ativo = r.value !== false && r.value !== 'false';
    }
  } catch (e) {}
  aplicarEfeito3D(ativo);
}

function setupVisualMotion(){
  const efeitoAtivo = document.documentElement.getAttribute('data-efeito-3d') !== 'false';
  const vendasExpandidas = !!produtosExpandido;

  const desativarTilt = (el) => {
    el.onpointermove = null;
    el.onpointerleave = null;
    el.classList.remove('interactive-tilt');
    el.style.transform = 'none';
    el.style.boxShadow = '';
    el.style.perspective = 'none';
    el.style.transformStyle = 'flat';
    el.style.setProperty('--glow-x', '50%');
    el.style.setProperty('--glow-y', '50%');
    delete el.dataset.tiltBound;
  };

  if (!efeitoAtivo || vendasExpandidas) {
    document.querySelectorAll('.interactive-tilt, .glass, .prod-card, .row-card, .modal-card, .stat, .venda-reciente-card, .xml-nota-card').forEach((el) => {
      desativarTilt(el);
    });
    return;
  }

  const targets = document.querySelectorAll('.glass, .prod-card, .row-card, .modal-card, .stat, .venda-reciente-card, .xml-nota-card');

  targets.forEach((el) => {
    if (el.dataset.tiltBound) return;
    el.dataset.tiltBound = 'true';
    el.classList.add('interactive-tilt');

    el.onpointermove = (event) => {
      const rect = el.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      const rotateY = (x - 0.5) * 12;
      const rotateX = (0.5 - y) * 12;
      const glowX = `${x * 100}%`;
      const glowY = `${y * 100}%`;

      el.style.transform = `perspective(1200px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-2px)`;
      el.style.setProperty('--glow-x', glowX);
      el.style.setProperty('--glow-y', glowY);
      el.style.boxShadow = `inset 0 1px 0 rgba(255,255,255,0.68), 0 22px 30px -22px rgba(0,0,0,0.32), 0 12px 30px -18px rgba(228,52,47,0.26)`;
    };

    el.onpointerleave = () => {
      el.style.transform = '';
      el.style.boxShadow = '';
      el.style.setProperty('--glow-x', '50%');
      el.style.setProperty('--glow-y', '50%');
    };
  });
}

async function initTheme(){
  let tema = 'dark';
  let temaVisual = 'belo-frango-2026';
  try{
    const r = await window.storage.get('tema', false);
    if(r) tema = r.value;
    const visual = await window.storage.get('temaVisual', false);
    if(visual && ['belo-frango-2026','monocromatico'].includes(visual.value)) temaVisual = visual.value;
  }catch(e){}
  aplicarTema(tema);
  aplicarTemaVisual(temaVisual);
}
function aplicarTema(tema){
  document.documentElement.setAttribute('data-theme', tema);
  document.getElementById('themeToggle').textContent = tema==='dark' ? '☀️' : '🌙';
}
function aplicarTemaVisual(temaVisual){
  document.documentElement.setAttribute('data-visual-theme', temaVisual);
  const select = document.getElementById('temaVisualSelect');
  if(select) select.value = temaVisual;
}
document.getElementById('themeToggle').addEventListener('click', async ()=>{
  const atual = document.documentElement.getAttribute('data-theme') || 'light';
  const novo = atual==='dark' ? 'light' : 'dark';
  aplicarTema(novo);
  try{ await window.storage.set('tema', novo, false); }catch(e){}
});
document.getElementById('temaVisualSelect').addEventListener('change', async e=>{
  aplicarTemaVisual(e.target.value);
  try{ await window.storage.set('temaVisual', e.target.value, false); }catch(e){}
});

document.getElementById('efeito3dToggleBtn').addEventListener('click', async ()=>{
  const atual = document.documentElement.getAttribute('data-efeito-3d') !== 'false';
  const novo = !atual;
  aplicarEfeito3D(novo);
  try { await window.storage.set('efeito3d', novo); } catch (e) {}
  setupVisualMotion();
});

/* ---------------- Fundo animado/estático ---------------- */
async function initFundo(){
  let fundo = 'estatico';
  try{
    const r = await window.storage.get('fundo', false);
    if(r) fundo = r.value;
  }catch(e){}
  aplicarFundo(fundo);
}
function aplicarFundo(fundo){
  document.documentElement.setAttribute('data-fundo', fundo);
  document.getElementById('fundoToggle').textContent = fundo==='animado' ? '⏸️' : '🎞️';
  document.getElementById('fundoToggle').title = fundo==='animado' ? 'Mudar para fundo estático' : 'Mudar para fundo animado';
}
document.getElementById('fundoToggle').addEventListener('click', async ()=>{
  const atual = document.documentElement.getAttribute('data-fundo') || 'estatico';
  const novo = atual==='animado' ? 'estatico' : 'animado';
  aplicarFundo(novo);
  try{ await window.storage.set('fundo', novo, false); }catch(e){}
});

/* ---------------- Storage ---------------- */
async function loadAll(){
  try{
    const snapshot = await window.storage.get('pdv_snapshot', true).catch(()=>null);
    const snapshotData = snapshot && snapshot.value ? JSON.parse(snapshot.value) : null;
    const [p,c,v,b,vd,cfg,notas,caixa] = await Promise.all([
      window.storage.get('produtos', true).catch(()=>null),
      window.storage.get('clientes', true).catch(()=>null),
      window.storage.get('vendas', true).catch(()=>null),
      window.storage.get('boletos', true).catch(()=>null),
      window.storage.get('vendedores', true).catch(()=>null),
      window.storage.get('configPagamentos', true).catch(()=>null),
      window.storage.get('notasImportadas', true).catch(()=>null),
      window.storage.get('caixa', true).catch(()=>null),
    ]);
    state.produtos = p ? JSON.parse(p.value) : seedProdutos();
    state.clientes = c ? JSON.parse(c.value) : [];
    state.vendas = v ? JSON.parse(v.value) : [];
    state.boletos = b ? JSON.parse(b.value) : [];
    state.vendedores = vd ? JSON.parse(vd.value) : seedVendedores();
    state.configPagamentos = cfg ? JSON.parse(cfg.value) : { qrPix:'', qrPicPay:'' };
    state.notasImportadas = notas ? JSON.parse(notas.value) : [];
    const caixaSalvo = caixa ? JSON.parse(caixa.value) : null;
    state.caixa = normalizarCaixaPadrao(caixaSalvo || {
      aberto: false,
      saldoInicial: VALOR_CAIXA_PADRAO,
      saldoFinal: VALOR_CAIXA_PADRAO,
      trocoInicial: VALOR_CAIXA_PADRAO,
      estoqueTroco: ESTOQUE_TROCO_PADRAO,
      movimentacoes: []
    });

    const caixaInvalido = !caixaSalvo ||
      Number(caixaSalvo.trocoInicial ?? 0) <= 0 ||
      Number(caixaSalvo.saldoInicial ?? 0) <= 0 ||
      Number(caixaSalvo.estoqueTroco ?? 0) <= 0;

    if(caixaInvalido){
      state.caixa = normalizarCaixaPadrao({
        aberto: false,
        saldoInicial: VALOR_CAIXA_PADRAO,
        saldoFinal: VALOR_CAIXA_PADRAO,
        trocoInicial: VALOR_CAIXA_PADRAO,
        estoqueTroco: ESTOQUE_TROCO_PADRAO,
        movimentacoes: []
      });
      await saveCaixa();
    }

    const padraoYuri = { id: uid(), nome: 'Yuri', username: 'yuri', senha: '123' };
    const vendedoresNormalizados = (state.vendedores || []).map(v => ({
      ...v,
      nome: v.nome || 'Vendedor',
      username: (v.username || '').trim().toLowerCase() || 'vendedor',
      senha: v.senha || '123'
    }));
    const usuarioExiste = vendedoresNormalizados.some(v => ['yuri', 'yurisnow', 'snw.'].includes((v.username || '').toLowerCase()));
    state.vendedores = usuarioExiste ? vendedoresNormalizados : [padraoYuri, ...vendedoresNormalizados];
    if (!state.vendedores.some(v => (v.username || '').toLowerCase() === 'yuri')) {
      state.vendedores.unshift({ ...padraoYuri, id: uid() });
    }

    if(!p) await saveProdutos();
    if(!vd || !usuarioExiste) await saveVendedores();
    if(!caixa) await saveCaixa();
  }catch(e){
    console.error('Erro ao carregar dados', e);
    state.produtos = seedProdutos();
    state.vendedores = seedVendedores();
    state.caixa = normalizarCaixaPadrao({
      aberto: false,
      saldoInicial: VALOR_CAIXA_PADRAO,
      saldoFinal: VALOR_CAIXA_PADRAO,
      trocoInicial: VALOR_CAIXA_PADRAO,
      estoqueTroco: ESTOQUE_TROCO_PADRAO,
      movimentacoes: []
    });
    toast('Não foi possível carregar dados salvos, iniciando do zero.');
  }
  state.loaded = true;
  await saveSnapshotPDV();
}
function obterSnapshotPDV(){
  return {
    produtos: state.produtos,
    clientes: state.clientes,
    vendas: state.vendas,
    boletos: state.boletos,
    vendedores: state.vendedores,
    notasImportadas: state.notasImportadas,
    configPagamentos: state.configPagamentos,
    caixa: state.caixa,
    ultimoLogin: state.vendedorLogado ? { id: state.vendedorLogado.id, nome: state.vendedorLogado.nome, username: state.vendedorLogado.username } : null,
    atualizadoEm: new Date().toISOString()
  };
}

function aplicarSnapshotServidor(snapshotData){
  if (!snapshotData || typeof snapshotData !== 'object') return;

  const chavesPersistidas = [
    'produtos', 'clientes', 'vendas', 'boletos', 'vendedores',
    'notasImportadas', 'configPagamentos', 'caixa', 'ultimoLogin'
  ];

  chavesPersistidas.forEach(chave => {
    if (snapshotData[chave] !== undefined) {
      if (chave === 'caixa') {
        state.caixa = normalizarCaixaPadrao(snapshotData.caixa || {});
      } else {
        state[chave] = snapshotData[chave];
      }
    }
  });

  if (snapshotData.atualizadoEm) {
    ultimaSincronizacaoRemota = snapshotData.atualizadoEm;
  }

  if (snapshotData.ultimoLogin) {
    const vendedorRestaurado = state.vendedores.find(v =>
      String(v.id) === String(snapshotData.ultimoLogin.id) ||
      v.username === snapshotData.ultimoLogin.username ||
      v.nome === snapshotData.ultimoLogin.nome
    );
    if (vendedorRestaurado) state.vendedorLogado = vendedorRestaurado;
  }
}

async function sincronizarComServidor(){
  try {
    const chaves = ['produtos', 'clientes', 'vendas', 'boletos', 'vendedores', 'configPagamentos', 'notasImportadas', 'caixa'];
    const respostas = await Promise.all(chaves.map(chave => window.storage.get(chave, true).catch(() => null)));
    chaves.forEach((chave, indice) => {
      const resposta = respostas[indice];
      if (!resposta || typeof resposta.value !== 'string') return;
      try {
        const valor = JSON.parse(resposta.value);
        state[chave] = chave === 'caixa' ? normalizarCaixaPadrao(valor) : valor;
      } catch (erro) {
        console.warn(`Dados remotos inválidos em ${chave}`, erro);
      }
    });
    renderProdutos(); renderCart(); renderEstoque(); renderClientes(); renderVendedores();
    renderConfigPagamentos(); renderVendasRecentes(); renderBoletos(); renderNotasImportadas();
    renderHistorico(); renderFaturamento(); renderCaixa();
    if (state.vendedorLogado) {
      atualizarPerfilVendedorLogado?.();
    }
  } catch (erro) {
    console.warn('Falha ao sincronizar snapshot do servidor', erro);
  }
}

async function saveSnapshotPDV(){
  return Promise.resolve();
}

async function saveProdutos(){ try{ await window.storage.set('produtos', JSON.stringify(state.produtos), true); }catch(e){ console.error(e); } }
async function saveClientes(){ try{ await window.storage.set('clientes', JSON.stringify(state.clientes), true); }catch(e){ console.error(e); } }
async function saveVendas(){ try{ await window.storage.set('vendas', JSON.stringify(state.vendas), true); }catch(e){ console.error(e); } }
async function saveBoletos(){ try{ await window.storage.set('boletos', JSON.stringify(state.boletos), true); }catch(e){ console.error(e); } }
async function saveVendedores(){ try{ await window.storage.set('vendedores', JSON.stringify(state.vendedores), true); }catch(e){ console.error(e); } }
async function saveConfigPagamentos(){ try{ await window.storage.set('configPagamentos', JSON.stringify(state.configPagamentos), true); }catch(e){ console.error(e); } }
async function saveNotasImportadas(){ try{ await window.storage.set('notasImportadas', JSON.stringify(state.notasImportadas), true); }catch(e){ console.error(e); } }
async function saveCaixa(){ try{ await window.storage.set('caixa', JSON.stringify(state.caixa), true); }catch(e){ console.error(e); } }
function seedVendedores(){
  return [
    { id: uid(), nome:'Yuri Snow', username:'yurisnow', senha:'123' },
    { id: uid(), nome:'Yuri', username:'yuri', senha:'123' }
  ];
}

function seedProdutos(){
  return [
    { id: uid(), codigo:'0001', codigoBarras:'7890000000011', nome:'Peito de frango', unidade:'kg', preco:22.90, estoque:18, minimo:5 },
    { id: uid(), codigo:'0002', codigoBarras:'7890000000028', nome:'Coxa e sobrecoxa', unidade:'kg', preco:14.90, estoque:22, minimo:5 },
    { id: uid(), codigo:'0003', codigoBarras:'7890000000035', nome:'Asa de frango', unidade:'kg', preco:13.50, estoque:12, minimo:4 },
    { id: uid(), codigo:'0004', codigoBarras:'7890000000042', nome:'Filé de peito', unidade:'kg', preco:26.90, estoque:9, minimo:4 },
    { id: uid(), codigo:'0005', codigoBarras:'7890000000059', nome:'Frango inteiro', unidade:'un', preco:19.90, estoque:15, minimo:5 },
    { id: uid(), codigo:'0006', codigoBarras:'7890000000066', nome:'Coração de frango', unidade:'kg', preco:24.90, estoque:4, minimo:3 },
    { id: uid(), codigo:'0007', codigoBarras:'7890000000073', nome:'Creme de leite', unidade:'un', preco:4.50, estoque:30, minimo:8 },
    { id: uid(), codigo:'0008', codigoBarras:'7890000000080', nome:'Batata palha', unidade:'un', preco:8.90, estoque:20, minimo:5 },
    { id: uid(), codigo:'0009', codigoBarras:'7890000000097', nome:'Leite condensado', unidade:'un', preco:6.90, estoque:24, minimo:6 },
    { id: uid(), codigo:'0010', codigoBarras:'7890000000103', nome:'Óleo de soja', unidade:'un', preco:7.50, estoque:18, minimo:5 },
    { id: uid(), codigo:'0011', codigoBarras:'7890000000110', nome:'Arroz 5kg', unidade:'un', preco:24.90, estoque:14, minimo:4 },
    { id: uid(), codigo:'0012', codigoBarras:'7890000000127', nome:'Feijão carioca 1kg', unidade:'un', preco:8.20, estoque:16, minimo:4 },
  ];
}
function proximoCodigo(){
  const nums = state.produtos.map(p=>parseInt((p.codigo||'').replace(/\D/g,''),10)).filter(n=>!isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return String(max+1).padStart(4,'0');
}

/* ---------------- Busca fuzzy ---------------- */
function normalizar(s){
  return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}
function levenshtein(a,b){
  const m=a.length, n=b.length;
  if(m===0) return n; if(n===0) return m;
  const d = Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);
  for(let j=0;j<=n;j++) d[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const custo = a[i-1]===b[j-1] ? 0 : 1;
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+custo);
    }
  }
  return d[m][n];
}
function similaridade(a,b){
  if(!a || !b) return 0;
  const dist = levenshtein(a,b);
  const maior = Math.max(a.length,b.length) || 1;
  return 1 - dist/maior;
}
function produtoCorresponde(produto, queryNorm){
  const nomeNorm = normalizar(produto.nome);
  const codigoNorm = normalizar(produto.codigo);
  const barrasNorm = normalizar(produto.codigoBarras||'');
  if(barrasNorm && barrasNorm===queryNorm) return {match:true, score:1};
  if(codigoNorm && (codigoNorm===queryNorm || codigoNorm.includes(queryNorm))) return {match:true, score:1};
  if(nomeNorm.includes(queryNorm)) return {match:true, score:0.97};
  const simTotal = similaridade(nomeNorm, queryNorm);
  const qTokens = queryNorm.split(/\s+/).filter(Boolean);
  const nTokens = nomeNorm.split(/\s+/).filter(Boolean);
  const tokenScores = qTokens.map(qt => nTokens.length ? Math.max(...nTokens.map(nt=>similaridade(qt,nt))) : 0);
  const mediaToken = tokenScores.length ? tokenScores.reduce((a,b)=>a+b,0)/tokenScores.length : 0;
  const score = Math.max(simTotal, mediaToken);
  return { match: score >= 0.55, score };
}
function buscaAtual(){
  const campo = document.getElementById('buscaProduto');
  return campo ? campo.value : '';
}
function proximoCodigoCliente(){
  const nums = state.clientes.map(c=>parseInt((c.codigo||'').replace(/\D/g,''),10)).filter(n=>!isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return String(max+1).padStart(4,'0');
}
function clienteCorresponde(cliente, queryNorm){
  const nomeNorm = normalizar(cliente.nome);
  const codigoNorm = normalizar(cliente.codigo);
  const telNorm = normalizar(cliente.telefone||'');
  const emailNorm = normalizar(cliente.email||'');
  const localNorm = normalizar([cliente.bairro, cliente.cidade].filter(Boolean).join(' '));
  if(codigoNorm && (codigoNorm===queryNorm || codigoNorm.includes(queryNorm))) return {match:true, score:1};
  if(telNorm && telNorm.includes(queryNorm)) return {match:true, score:0.98};
  if(emailNorm && emailNorm.includes(queryNorm)) return {match:true, score:0.95};
  if(nomeNorm.includes(queryNorm)) return {match:true, score:0.97};
  if(localNorm && localNorm.includes(queryNorm)) return {match:true, score:0.9};
  const simTotal = similaridade(nomeNorm, queryNorm);
  const qTokens = queryNorm.split(/\s+/).filter(Boolean);
  const nTokens = nomeNorm.split(/\s+/).filter(Boolean);
  const tokenScores = qTokens.map(qt => nTokens.length ? Math.max(...nTokens.map(nt=>similaridade(qt,nt))) : 0);
  const mediaToken = tokenScores.length ? tokenScores.reduce((a,b)=>a+b,0)/tokenScores.length : 0;
  const score = Math.max(simTotal, mediaToken);
  return { match: score >= 0.55, score };
}

/* ---------------- Navegação ---------------- */
document.getElementById('nav').addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-tab]');
  if(!btn) return;
  document.querySelectorAll('#nav button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('main .tab').forEach(s=>s.classList.remove('active'));
  document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
  if(btn.dataset.tab === 'historico') renderHistorico();
  if(btn.dataset.tab === 'boletos') renderBoletos();
  if(btn.dataset.tab === 'vendedores') renderVendedores();
  if(btn.dataset.tab === 'faturamento') renderFaturamento();
});

/* ---------------- PDV: produtos + carrinho ---------------- */
let produtosExpandido = false;

function renderProdutos(query){
  if(query === undefined) query = buscaAtual();
  const grid = document.getElementById('prodGrid');
  const qNorm = normalizar(query);
  let lista = state.produtos;
  if(qNorm){
    lista = state.produtos
      .map(p => ({ p, r: produtoCorresponde(p, qNorm) }))
      .filter(x => x.r.match)
      .sort((a,b) => b.r.score - a.r.score)
      .map(x => x.p);
  }
  if(state.produtos.length === 0){
    grid.innerHTML = `<div class="empty-state full">Nenhum produto cadastrado ainda. Vá em Estoque para adicionar.</div>`;
    setupVisualMotion();
    return;
  }
  if(lista.length === 0){
    grid.innerHTML = `<div class="empty-state full">Nenhum produto encontrado para "${query}".</div>`;
    setupVisualMotion();
    return;
  }

  // Mostrar apenas 10 itens (5 horizontais x 2 verticais) se não expandido
  const itensVisiveis = produtosExpandido ? lista : lista.slice(0, 10);

  grid.innerHTML = `
    <div class="prod-limit-container">
      <div class="prod-limit-wrapper ${produtosExpandido ? 'expanded' : ''}">
        <div class="prod-grid-wrapper ${produtosExpandido ? 'expanded' : 'recolhido'}">
          ${itensVisiveis.map(p=>{
            const low = p.estoque <= p.minimo && p.estoque > 0;
            const esgotado = p.estoque <= 0;
            return `<div class="prod-card ${low?'low':''} ${esgotado?'esgotado':''}" data-id="${p.id}">
              <div class="cod">#${p.codigo}</div>
              <div class="nome">${p.nome}</div>
              <div class="preco">${fmt(p.preco)} <small style="font-weight:600;color:var(--ink-soft)">/${p.unidade}</small></div>
              <div class="estoque-tag">${esgotado?'Esgotado':(p.estoque.toFixed(p.unidade==='kg'?1:0)+' '+p.unidade+' em estoque')}</div>
            </div>`;
          }).join('')}
        </div>
      </div>
      ${lista.length > 10 ? `<button class="prod-expander" id="btnExpandirProdutos">${produtosExpandido ? 'Recolher itens' : `+${lista.length - itensVisiveis.length} itens recolhidos`}</button>` : ''}
    </div>
  `;

  // Adicionar event listener para botão de expansão se existir
  const btnExpandir = document.getElementById('btnExpandirProdutos');
  if(btnExpandir){
    btnExpandir.addEventListener('click', () => {
      produtosExpandido = !produtosExpandido;
      renderProdutos(query);
      setupVisualMotion();
    });
  }
  setupVisualMotion();
}
document.getElementById('buscaProduto').addEventListener('input', (e)=> renderProdutos(e.target.value));

let pesoModalProdutoId = null;
function abrirModalPeso(prod){
  pesoModalProdutoId = prod.id;
  document.getElementById('pesoModalNome').textContent = prod.nome;
  const input = document.getElementById('pesoInput');
  input.value = '1,000';
  document.getElementById('pesoModal').classList.add('show');
  setTimeout(()=>{ input.focus(); input.select(); }, 60);
}
function fecharModalPeso(){
  document.getElementById('pesoModal').classList.remove('show');
  pesoModalProdutoId = null;
}
function confirmarPeso(){
  const prod = state.produtos.find(p=>p.id===pesoModalProdutoId);
  if(!prod) return;
  const bruto = document.getElementById('pesoInput').value.replace(',', '.');
  const val = parseFloat(bruto);
  if(isNaN(val) || val<=0){ toast('Informe um peso válido.'); return; }
  const item = state.cart.find(i=>i.id===prod.id);
  const jaTem = item ? item.qtd : 0;
  if(+(jaTem+val).toFixed(3) > prod.estoque){ toast('Quantidade acima do estoque disponível.'); return; }
  if(item){ item.qtd = +(item.qtd + val).toFixed(3); }
  else { state.cart.push({ id:prod.id, nome:prod.nome, unidade:prod.unidade, preco:prod.preco, qtd:+val.toFixed(3) }); }
  fecharModalPeso();
  renderCart();
}
document.getElementById('pesoConfirmar').addEventListener('click', confirmarPeso);
document.getElementById('pesoCancelar').addEventListener('click', fecharModalPeso);
document.getElementById('pesoInput').addEventListener('keydown', (e)=>{ if(e.key==='Enter') confirmarPeso(); });

function adicionarProdutoAoCarrinho(prod){
  if(!prod || prod.estoque <= 0){ toast('Produto sem estoque disponível.'); return; }
  if(prod.unidade === 'kg'){
    abrirModalPeso(prod);
    return;
  }
  const item = state.cart.find(i=>i.id === prod.id);
  if(item){
    if(item.qtd + 1 > prod.estoque){ toast('Quantidade acima do estoque disponível.'); return; }
    item.qtd += 1;
  } else {
    state.cart.push({ id:prod.id, nome:prod.nome, unidade:prod.unidade, preco:prod.preco, qtd:1 });
  }
  renderCart();
}
document.getElementById('prodGrid').addEventListener('click', (e)=>{
  const card = e.target.closest('.prod-card');
  if(!card) return;
  const prod = state.produtos.find(p=>p.id === card.dataset.id);
  adicionarProdutoAoCarrinho(prod);
});

/* ---------------- Leitor de código de barras ---------------- */
function buscarPorCodigoBarras(codigo){
  const cod = codigo.trim();
  if(!cod) return;
  const prod = state.produtos.find(p => p.codigoBarras && p.codigoBarras === cod)
    || state.produtos.find(p => p.codigo === cod);
  if(!prod){ toast('Nenhum produto encontrado para o código "'+cod+'".'); return; }
  adicionarProdutoAoCarrinho(prod);
}
let scannerBuffer = '';
let scannerUltimaTecla = 0;
document.addEventListener('keydown', (e)=>{
  const appVisivel = document.getElementById('appWrapper').style.display !== 'none';
  const abaPdvAtiva = document.getElementById('tab-pdv').classList.contains('active');
  if(!appVisivel || !abaPdvAtiva) return;
  const ativo = document.activeElement;
  const emCampoTexto = ativo && (ativo.tagName==='INPUT' || ativo.tagName==='TEXTAREA');
  const agora = Date.now();
  if(agora - scannerUltimaTecla > 80){ scannerBuffer = ''; }
  scannerUltimaTecla = agora;
  if(e.key === 'Enter'){
    if(scannerBuffer.length >= 3 && !emCampoTexto){
      buscarPorCodigoBarras(scannerBuffer);
    }
    scannerBuffer = '';
    return;
  }
  if(e.key.length === 1 && /[0-9A-Za-z-]/.test(e.key) && !emCampoTexto){
    scannerBuffer += e.key;
  }
});
document.getElementById('scannerInput').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter'){
    buscarPorCodigoBarras(e.target.value);
    e.target.value = '';
  }
});

function renderCart(){
  const wrap = document.getElementById('cartItems');
  if(state.cart.length === 0){
    wrap.innerHTML = `<div class="cart-empty">Toque em um produto para adicionar à venda</div>`;
  } else {
    wrap.innerHTML = state.cart.map(item=>`
      <div class="cart-item" data-id="${item.id}">
        <div class="info"><b>${item.nome}</b><small>${fmt(item.preco)} / ${item.unidade}</small></div>
        <div class="qty-ctrl">
          <button data-act="menos">−</button>
          <input type="text" value="${item.unidade==='kg' ? item.qtd.toFixed(3).replace('.',',') : item.qtd}" data-act="edit" />
          <button data-act="mais">+</button>
        </div>
        <div style="font-weight:800; min-width:64px; text-align:right;">${fmt(item.preco*item.qtd)}</div>
        <button data-act="remover" style="border:none;background:transparent;color:var(--vermelho);font-weight:800;cursor:pointer;">✕</button>
      </div>`).join('');
  }
  const totalItens = state.cart.reduce((a,i)=>a+i.qtd,0);
  const total = state.cart.reduce((a,i)=>a+i.qtd*i.preco,0);
  const totalComDescontoValor = totalComDesconto();
  document.getElementById('totalItens').textContent = totalItens.toFixed(3).replace(/0+$/,'').replace(/\.$/,'') || '0';
  document.getElementById('totalVenda').textContent = fmt(totalComDescontoValor);
  document.getElementById('finalizarBtn').disabled = state.cart.length === 0;
  atualizarTroco();
  if(state.pagamento === 'Cartão' && state.pagamentoDetalhe === 'Crédito') renderParcelamento();
}

document.getElementById('cartItems').addEventListener('click',(e)=>{
  const row = e.target.closest('.cart-item'); if(!row) return;
  const item = state.cart.find(i=>i.id===row.dataset.id);
  const prod = state.produtos.find(p=>p.id===row.dataset.id);
  const step = item.unidade==='kg' ? 0.1 : 1;
  const act = e.target.dataset.act;
  if(act==='mais'){
    if(+(item.qtd+step).toFixed(3) > prod.estoque){ toast('Quantidade acima do estoque disponível.'); return; }
    item.qtd = +(item.qtd+step).toFixed(3);
  } else if(act==='menos'){
    item.qtd = +(item.qtd-step).toFixed(3);
    if(item.qtd <= 0){ state.cart = state.cart.filter(i=>i.id!==item.id); }
  } else if(act==='remover'){
    state.cart = state.cart.filter(i=>i.id!==item.id);
  }
  renderCart();
});
document.getElementById('cartItems').addEventListener('change',(e)=>{
  if(e.target.dataset.act!=='edit') return;
  const row = e.target.closest('.cart-item');
  const item = state.cart.find(i=>i.id===row.dataset.id);
  const prod = state.produtos.find(p=>p.id===row.dataset.id);
  let val = parseFloat(e.target.value.replace(',','.'));
  if(isNaN(val) || val<=0){ val = item.qtd; }
  val = item.unidade==='kg' ? +val.toFixed(3) : Math.round(val);
  if(val > prod.estoque){ toast('Quantidade acima do estoque disponível.'); val = prod.estoque; }
  item.qtd = val;
  renderCart();
});

/* ---------------- Pagamento ---------------- */
const TAXA_JUROS_PARCELAMENTO = 0.0299;
function totalCarrinho(){ return state.cart.reduce((a,i)=>a+i.qtd*i.preco,0); }
function totalComDesconto(){
  const subtotal = totalCarrinho();
  const desconto = Number(document.getElementById('descontoInput')?.value || 0);
  return Math.max(0, subtotal - desconto);
}
function atualizarTroco(){
  const recebido = Number(document.getElementById('recebimentoInput')?.value || 0);
  const total = totalComDesconto();
  const troco = Math.max(0, recebido - total);
  const el = document.getElementById('recebimentoTroco');
  if(el){ el.textContent = fmt(troco); }
}
function calcularValorParcela(total, parcelas){
  if(state.tipoJuros === 'sem' || parcelas === 1) return total / parcelas;
  const taxa = TAXA_JUROS_PARCELAMENTO;
  return total * (taxa * Math.pow(1 + taxa, parcelas)) / (Math.pow(1 + taxa, parcelas) - 1);
}
function calcularParcelamento(total){ return calcularValorParcela(total, state.parcelas) * state.parcelas; }
function renderParcelamento(){
  const grid = document.getElementById('parcelasGrid');
  const total = totalCarrinho();
  grid.innerHTML = Array.from({length:12}, (_,i)=>{
    const n = i + 1;
    return `<button class="parcela-btn ${n===state.parcelas?'sel':''}" data-parcelas="${n}">${n}x<small>${fmt(calcularValorParcela(total, n))}</small></button>`;
  }).join('');
  const totalFinal = calcularParcelamento(total);
  const descricaoJuros = state.tipoJuros === 'sem' ? 'sem juros' : `com juros de ${(TAXA_JUROS_PARCELAMENTO*100).toFixed(2).replace('.',',')}% a.m.`;
  document.getElementById('parcelaResumo').textContent = total ? `${state.parcelas}x de ${fmt(totalFinal/state.parcelas)} · Total ${fmt(totalFinal)} · ${descricaoJuros}` : `Escolha de 1x a 12x · ${descricaoJuros}`;
}
document.getElementById('pagamentos').addEventListener('click',(e)=>{
  const btn = e.target.closest('button[data-p]'); if(!btn) return;
  document.querySelectorAll('#pagamentos button').forEach(b=>b.classList.remove('sel'));
  btn.classList.add('sel');
  state.pagamento = btn.dataset.p;
  const subCartao = document.getElementById('subCartao');
  if(state.pagamento === 'Cartão'){
    subCartao.classList.add('show');
    if(!state.pagamentoDetalhe) state.pagamentoDetalhe = 'Crédito';
    document.getElementById('parcelamento').classList.toggle('show', state.pagamentoDetalhe === 'Crédito');
    renderParcelamento();
  } else {
    subCartao.classList.remove('show');
    document.getElementById('parcelamento').classList.remove('show');
    state.pagamentoDetalhe = null;
  }
  const el = document.getElementById('recebimentoInput');
  if(el && document.getElementById('recebimentoModal')?.classList.contains('show')) atualizarTroco();
});
document.getElementById('subCartao').addEventListener('click',(e)=>{
  const btn = e.target.closest('button[data-c]'); if(!btn) return;
  document.querySelectorAll('#subCartao button').forEach(b=>b.classList.remove('sel'));
  btn.classList.add('sel');
  state.pagamentoDetalhe = btn.dataset.c;
  document.getElementById('parcelamento').classList.toggle('show', state.pagamentoDetalhe === 'Crédito');
  if(state.pagamentoDetalhe === 'Crédito') renderParcelamento();
});
document.getElementById('jurosTipo').addEventListener('click',(e)=>{
  const btn = e.target.closest('button[data-j]'); if(!btn) return;
  document.querySelectorAll('#jurosTipo button').forEach(b=>b.classList.remove('sel'));
  btn.classList.add('sel');
  state.tipoJuros = btn.dataset.j;
  renderParcelamento();
});
document.getElementById('parcelasGrid').addEventListener('click',(e)=>{
  const btn = e.target.closest('button[data-parcelas]'); if(!btn) return;
  state.parcelas = Number(btn.dataset.parcelas);
  renderParcelamento();
});

document.getElementById('limparCarrinho').addEventListener('click', ()=>{
  state.cart = [];
  renderCart();
  renderVendasRecentes();
});

function proximoCodigoVenda(){
  const nums = state.vendas.map(v=>parseInt((v.codigo||'').replace(/\D/g,''),10)).filter(n=>!isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return 'V' + String(max+1).padStart(4,'0');
}

let valorRecebidoAtual = 0;

async function finalizarVendaAgora(){
  const subtotal = totalCarrinho();
  const desconto = Number(document.getElementById('descontoInput')?.value || 0);
  const totalComDescontoValor = Math.max(0, subtotal - desconto);
  const total = state.pagamento === 'Cartão' && state.pagamentoDetalhe === 'Crédito' ? calcularParcelamento(totalComDescontoValor) : totalComDescontoValor;
  const clienteId = state.clienteSelecionadoId || null;
  const cliente = state.clientes.find(c=>c.id===clienteId);
  state.cart.forEach(item=>{
    const prod = state.produtos.find(p=>p.id===item.id);
    if(prod) prod.estoque = Math.max(0, +(prod.estoque - item.qtd).toFixed(2));
  });
  const pagamentoFinal = state.pagamento === 'Cartão' ? `Cartão (${state.pagamentoDetalhe}${state.pagamentoDetalhe === 'Crédito' ? ` · ${state.parcelas}x ${state.tipoJuros === 'sem' ? 'sem juros' : 'com juros'}` : ''})` : state.pagamento;
  const venda = {
    id: uid(), codigo: proximoCodigoVenda(), data: new Date().toISOString(),
    itens: state.cart.map(i=>({produtoId:i.id, codigo:i.codigo, nome:i.nome, qtd:i.qtd, unidade:i.unidade, preco:i.preco, custo:i.custo||state.produtos.find(p=>p.id===i.id)?.custo||0})),
    total, subtotal, desconto, pagamento: pagamentoFinal,
    clienteId: clienteId, clienteNome: cliente ? cliente.nome : null,
    clienteTelefone: cliente ? cliente.telefone : null, clienteEmail: cliente ? cliente.email : null,
    vendedorNome: state.vendedorLogado ? state.vendedorLogado.nome : null,
    cancelada: false,
    recebido: valorRecebidoAtual || total
  };
  state.vendas.unshift(venda);
  if(state.caixa.aberto){
    const entradaCaixa = {
      id: uid(),
      tipo: 'venda',
      descricao: `Venda ${venda.codigo}`,
      valor: state.pagamento === 'Dinheiro' ? total : 0,
      data: new Date().toISOString(),
      vendedor: state.vendedorLogado?.nome || 'Sistema'
    };
    state.caixa.movimentacoes.unshift(entradaCaixa);
    if(state.pagamento === 'Dinheiro'){
      state.caixa.saldoFinal = (Number(state.caixa.saldoFinal) || 0) + total;
    }
  }
  if(state.pagamento === 'Fiado'){
    state.boletos.unshift({
      id: uid(), vendaId: venda.id, codigoVenda: venda.codigo,
      clienteId: clienteId, clienteNome: cliente ? cliente.nome : 'Cliente não identificado',
      valor: total, vencimento: boletoVencimentoPendente, pago: false,
      criadoEm: new Date().toISOString(), tipo: 'receber'
    });
  }
  boletoVencimentoPendente = null;
  const dinheiroRecebido = Number(valorRecebidoAtual || 0);
  if(state.pagamento === 'Dinheiro' && state.caixa.aberto && dinheiroRecebido > 0){
    state.caixa.saldoFinal = (Number(state.caixa.saldoFinal) || 0) + (total - Math.min(dinheiroRecebido, total));
  }
  state.cart = [];
  document.getElementById('descontoInput').value = '0';
  valorRecebidoAtual = 0;
  await Promise.all([saveProdutos(), saveVendas(), saveBoletos(), saveCaixa()]);
  renderCart(); renderProdutos();
  limparClienteSelecionado();
  renderVendasRecentes();
  renderCaixa();
  toast('Venda finalizada: ' + fmt(venda.total));
  abrirComprovante(venda);
}

let boletoVencimentoPendente = null;
function dataLocalISO(data){
  const d = data || new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth()+1).padStart(2,'0');
  const dia = String(d.getDate()).padStart(2,'0');
  return `${ano}-${mes}-${dia}`;
}
function abrirModalBoleto(){
  const input = document.getElementById('boletoVencimento');
  const vencimento = new Date();
  vencimento.setDate(vencimento.getDate()+30);
  input.value = dataLocalISO(vencimento);
  document.getElementById('boletoModal').classList.add('show');
  setTimeout(()=>input.focus(), 60);
}
document.getElementById('boletoCancelar').addEventListener('click', ()=>{
  document.getElementById('boletoModal').classList.remove('show');
});
document.getElementById('boletoConfirmar').addEventListener('click', async ()=>{
  const vencimento = document.getElementById('boletoVencimento').value;
  if(!vencimento){ toast('Informe a data de vencimento.'); return; }
  boletoVencimentoPendente = vencimento;
  document.getElementById('boletoModal').classList.remove('show');
  await finalizarVendaAgora();
});

function abrirModalPagamentoQR(){
  const modal = document.getElementById('qrPagamentoModal');
  const img = document.getElementById('qrPagamentoImagem');
  const aviso = document.getElementById('qrPagamentoAviso');
  const titulo = document.getElementById('qrPagamentoTitulo');
  const total = state.cart.reduce((a,i)=>a+i.qtd*i.preco,0);
  titulo.textContent = 'Pagamento via ' + state.pagamento;
  document.getElementById('qrPagamentoTotal').textContent = fmt(total);
  const qrSrc = state.pagamento === 'Pix' ? state.configPagamentos.qrPix : state.configPagamentos.qrPicPay;
  if(qrSrc){
    img.src = qrSrc; img.style.display = 'block';
    aviso.textContent = 'Peça ao cliente para escanear e pagar. Clique em confirmar após receber.';
  } else {
    img.style.display = 'none';
    aviso.textContent = 'Nenhum QR Code cadastrado ainda. Cadastre na aba Config.';
  }
  modal.classList.add('show');
}
document.getElementById('qrPagamentoCancelar').addEventListener('click', ()=>{
  document.getElementById('qrPagamentoModal').classList.remove('show');
});
document.getElementById('qrPagamentoConfirmar').addEventListener('click', async ()=>{
  document.getElementById('qrPagamentoModal').classList.remove('show');
  await finalizarVendaAgora();
});

function abrirModalRecebimento(){
  const total = totalComDesconto();
  const modal = document.getElementById('recebimentoModal');
  const input = document.getElementById('recebimentoInput');
  const totalEl = document.getElementById('recebimentoTotal');
  if(!modal || !input || !totalEl) return;
  totalEl.textContent = fmt(total);
  input.value = total.toFixed(2);
  atualizarTroco();
  modal.classList.add('show');
  setTimeout(()=>input.focus(), 60);
}

document.getElementById('recebimentoInput').addEventListener('input', atualizarTroco);
document.getElementById('recebimentoCancelar').addEventListener('click', ()=>{
  document.getElementById('recebimentoModal').classList.remove('show');
});
document.getElementById('recebimentoConfirmar').addEventListener('click', async ()=>{
  const recebido = Number(document.getElementById('recebimentoInput').value || 0);
  const total = totalComDesconto();
  if(recebido < total){
    toast('Valor recebido é menor que o total da venda.');
    return;
  }
  valorRecebidoAtual = recebido;
  document.getElementById('recebimentoModal').classList.remove('show');
  await finalizarVendaAgora();
});

document.getElementById('finalizarBtn').addEventListener('click', async ()=>{
  if(state.cart.length===0) return;
  if(!state.caixa.aberto && ['Dinheiro','Cartão','Pix','PicPay'].includes(state.pagamento)){
    toast('Abra o caixa antes de iniciar as vendas.');
    return;
  }
  if(state.pagamento === 'Fiado' && !state.clienteSelecionadoId){
    toast('Venda fiado exige um cliente cadastrado. Selecione o cliente antes de finalizar.');
    document.getElementById('clienteBusca').focus();
    return;
  }
  if(state.pagamento === 'Fiado'){
    abrirModalBoleto();
    return;
  }
  if(state.pagamento === 'Pix' || state.pagamento === 'PicPay'){
    abrirModalPagamentoQR();
    return;
  }
  abrirModalRecebimento();
});

/* ---------------- Comprovante de venda ---------------- */
function gerarTextoComprovante(venda){
  const d = new Date(venda.data);
  const largura = 46;
  const centralizar = (texto, larguraFinal = largura) => {
    const trim = String(texto || '').slice(0, larguraFinal);
    const espacos = Math.max(0, Math.floor((larguraFinal - trim.length) / 2));
    return ' '.repeat(espacos) + trim;
  };
  const formatarLinha = (texto, valor, larguraFinal = largura) => {
    const left = String(texto || '').slice(0, Math.max(0, larguraFinal - 14));
    const right = String(valor || '').slice(0, 14);
    return (left + ' '.repeat(Math.max(1, larguraFinal - left.length - right.length)) + right).slice(0, larguraFinal);
  };

  const linhas = [];
  linhas.push('╔' + '═'.repeat(largura) + '╗');
  linhas.push('║' + centralizar('🍗 BELO FRANGO') + '║');
  linhas.push('║' + centralizar('📄 Comprovante de venda') + '║');
  linhas.push('╠' + '═'.repeat(largura) + '╣');
  linhas.push('║' + formatarLinha('🧾 Código', venda.codigo) + '║');
  linhas.push('║' + formatarLinha('📅 Data', d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })) + '║');
  linhas.push('║' + formatarLinha('👤 Vendedor', venda.vendedorNome || '-') + '║');
  linhas.push('║' + formatarLinha('🧍 Cliente', venda.clienteNome || 'Não identificado') + '║');
  linhas.push('╠' + '═'.repeat(largura) + '╣');
  linhas.push('║' + '🛒 ITEM'.padEnd(26) + 'QTD'.padStart(6) + 'VALOR'.padStart(10) + '║');
  linhas.push('╠' + '═'.repeat(largura) + '╣');

  venda.itens.forEach((i) => {
    const nome = (i.nome || 'Produto').slice(0, 20);
    const qtd = String(i.qtd).replace(/\.?0+$/, '') + (i.unidade || '');
    const valor = fmt(i.qtd * i.preco);
    linhas.push('║' + `${nome.padEnd(24)}${qtd.padStart(6)}${valor.padStart(10)}`.slice(0, largura) + '║');
  });

  if (venda.desconto && Number(venda.desconto) > 0) {
    linhas.push('╠' + '═'.repeat(largura) + '╣');
    linhas.push('║' + formatarLinha('💸 Desconto', '-' + fmt(venda.desconto)) + '║');
  }

  linhas.push('╠' + '═'.repeat(largura) + '╣');
  linhas.push('║' + formatarLinha('💰 Total', fmt(venda.total)) + '║');
  linhas.push('║' + formatarLinha('💳 Pagamento', venda.pagamento) + '║');
  linhas.push('║' + centralizar('🙏 Obrigado pela preferência!') + '║');
  linhas.push('╚' + '═'.repeat(largura) + '╝');
  return linhas.join('\n');
}
function renderVendasRecentes(){
  const grid = document.getElementById('vendasRecentesGrid');
  if(!grid) return;
  const vendasRecentes = state.vendas.slice(0, 2);
  if(vendasRecentes.length === 0){
    grid.innerHTML = `<div class="empty-state" style="padding:40px 20px;">Nenhuma venda registrada ainda.</div>`;
    return;
  }
  grid.innerHTML = vendasRecentes.map(v=>{
    const d = new Date(v.data);
    const dataFmt = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    const itensStr = v.itens.map(i=>`${i.nome}(${i.qtd}${i.unidade})`).join(', ');
    return `<div class="venda-reciente-card" data-id="${v.id}">
      <div class="venda-reciente-info">
        <span class="venda-reciente-codigo">#${v.codigo} · ${dataFmt}</span>
        <span class="venda-reciente-detalhes">
          <span>${v.pagamento}</span>
          <span>·</span>
          <span>${v.clienteNome || 'Sem cliente'}</span>
        </span>
        <span class="venda-reciente-itens">${itensStr}</span>
      </div>
      <span class="venda-reciente-total">${fmt(v.total)}</span>
    </div>`;
  }).join('');
}
function abrirComprovante(venda){
  const modal = document.getElementById('comprovanteModal');
  const texto = gerarTextoComprovante(venda);
  const bloco = document.getElementById('comprovanteTexto');
  bloco.textContent = texto;
  bloco.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.97), rgba(244,246,250,0.92))';
  bloco.style.color = '#1c1e25';
  bloco.style.border = '1px solid rgba(20,24,32,0.06)';
  bloco.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.9), 0 16px 28px -24px rgba(0,0,0,0.26)';
  bloco.style.lineHeight = '1.8';
  bloco.style.letterSpacing = '0.02em';
  bloco.style.padding = '18px 16px';
  bloco.style.borderRadius = '16px';

  const semCliente = !venda.clienteNome;
  document.getElementById('comprovanteAviso').textContent = semCliente
    ? 'Cliente não identificado nessa venda — você ainda pode gerar o comprovante avulso.'
    : `Comprovante da venda ${venda.codigo} para ${venda.clienteNome}.`;
  const btnEmail = document.getElementById('comprovanteEmailBtn');
  const btnWhats = document.getElementById('comprovanteWhatsBtn');
  if(venda.clienteEmail){
    btnEmail.style.display = 'block';
    btnEmail.onclick = ()=>{
      const assunto = encodeURIComponent('Comprovante Belo Frango - '+venda.codigo);
      const corpo = encodeURIComponent(texto);
      window.location.href = `mailto:${venda.clienteEmail}?subject=${assunto}&body=${corpo}`;
    };
  } else { btnEmail.style.display = 'none'; }
  if(venda.clienteTelefone){
    btnWhats.style.display = 'block';
    btnWhats.onclick = ()=>{
      const numeros = venda.clienteTelefone.replace(/\D/g,'');
      const msg = encodeURIComponent(texto);
      window.open(`https://wa.me/55${numeros}?text=${msg}`, '_blank');
    };
  } else { btnWhats.style.display = 'none'; }
  modal.classList.add('show');
}
document.getElementById('comprovanteFechar').addEventListener('click', ()=>{
  document.getElementById('comprovanteModal').classList.remove('show');
});

/* ---------------- Configurações de pagamento (QR) ---------------- */
function lerImagemComoDataURL(arquivo){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(arquivo);
  });
}
function renderConfigPagamentos(){
  const px = document.getElementById('qrPixPreview');
  const pp = document.getElementById('qrPicPayPreview');
  if(state.configPagamentos.qrPix){ px.src = state.configPagamentos.qrPix; px.style.display='block'; } else { px.style.display='none'; }
  if(state.configPagamentos.qrPicPay){ pp.src = state.configPagamentos.qrPicPay; pp.style.display='block'; } else { pp.style.display='none'; }
}
document.getElementById('qrPixInput').addEventListener('change', async (e)=>{
  const arq = e.target.files[0]; if(!arq) return;
  state.configPagamentos.qrPix = await lerImagemComoDataURL(arq);
  await saveConfigPagamentos();
  renderConfigPagamentos();
  toast('QR Code do Pix salvo.');
});
document.getElementById('qrPicPayInput').addEventListener('change', async (e)=>{
  const arq = e.target.files[0]; if(!arq) return;
  state.configPagamentos.qrPicPay = await lerImagemComoDataURL(arq);
  await saveConfigPagamentos();
  renderConfigPagamentos();
  toast('QR Code do PicPay salvo.');
});

function normalizarSnapshotRestaurado(dados){
  if(!dados || typeof dados !== 'object') throw new Error('Backup inválido.');
  return {
    produtos: Array.isArray(dados.produtos) ? dados.produtos : [],
    clientes: Array.isArray(dados.clientes) ? dados.clientes : [],
    vendas: Array.isArray(dados.vendas) ? dados.vendas : [],
    boletos: Array.isArray(dados.boletos) ? dados.boletos : [],
    vendedores: Array.isArray(dados.vendedores) ? dados.vendedores : [],
    notasImportadas: Array.isArray(dados.notasImportadas) ? dados.notasImportadas : [],
    configPagamentos: dados.configPagamentos && typeof dados.configPagamentos === 'object'
      ? dados.configPagamentos
      : { qrPix:'', qrPicPay:'' },
    caixa: normalizarCaixaPadrao(dados.caixa || {}),
    ultimoLogin: dados.ultimoLogin || null,
    atualizadoEm: dados.atualizadoEm || new Date().toISOString()
  };
}

async function exportarBackupPDV(){
  const snapshot = obterSnapshotPDV();
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `belo-frango-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Backup do PDV exportado.');
}

async function restaurarBackupPDV(arquivo){
  if(!arquivo) return;
  try{
    const texto = await arquivo.text();
    const dados = JSON.parse(texto);
    const snapshot = normalizarSnapshotRestaurado(dados);

    state.produtos = snapshot.produtos;
    state.clientes = snapshot.clientes;
    state.vendas = snapshot.vendas;
    state.boletos = snapshot.boletos;
    state.vendedores = snapshot.vendedores;
    state.notasImportadas = snapshot.notasImportadas;
    state.configPagamentos = snapshot.configPagamentos;
    state.caixa = normalizarCaixaPadrao(snapshot.caixa);

    const vendedorRestaurado = snapshot.ultimoLogin
      ? state.vendedores.find(v => String(v.id) === String(snapshot.ultimoLogin.id) || v.username === snapshot.ultimoLogin.username || v.nome === snapshot.ultimoLogin.nome)
      : null;
    state.vendedorLogado = vendedorRestaurado || state.vendedorLogado || null;

    await Promise.all([
      saveProdutos(),
      saveClientes(),
      saveVendas(),
      saveBoletos(),
      saveVendedores(),
      saveNotasImportadas(),
      saveConfigPagamentos(),
      saveCaixa(),
      saveSnapshotPDV()
    ]);

    renderClientes();
    renderProdutos();
    renderVendasRecentes();
    renderBoletos();
    renderHistorico();
    renderCaixa();
    renderFaturamento();
    renderConfigPagamentos();
    toast('Backup restaurado com sucesso.');
  }catch(err){
    console.error('Erro ao restaurar backup do PDV', err);
    toast('Arquivo de backup inválido.');
  }
}

document.getElementById('backupExportBtn').addEventListener('click', exportarBackupPDV);
document.getElementById('backupImportBtn').addEventListener('click', () => document.getElementById('backupImportInput').click());
document.getElementById('backupImportInput').addEventListener('change', async (e) => {
  const arquivo = e.target.files && e.target.files[0];
  if(!arquivo) return;
  await restaurarBackupPDV(arquivo);
  e.target.value = '';
});

function renderClienteDropdown(query){
  const dropdown = document.getElementById('clienteDropdown');
  const qNorm = normalizar(query||'');
  if(!qNorm){ dropdown.classList.remove('show'); dropdown.innerHTML=''; return; }
  const resultados = state.clientes
    .map(c => ({ c, r: clienteCorresponde(c, qNorm) }))
    .filter(x => x.r.match)
    .sort((a,b) => b.r.score - a.r.score)
    .map(x => x.c)
    .slice(0,8);
  if(resultados.length === 0){
    dropdown.innerHTML = `<div class="cliente-dropdown-item" style="cursor:default;color:var(--ink-soft);">Nenhum cliente encontrado</div>`;
  } else {
    dropdown.innerHTML = resultados.map(c=>`
      <div class="cliente-dropdown-item" data-id="${c.id}">
        <span>${c.nome}</span>
        <small>#${c.codigo}${c.telefone?(' · '+c.telefone):''}</small>
      </div>`).join('');
  }
  dropdown.classList.add('show');
}
function selecionarCliente(id){
  const c = state.clientes.find(x=>x.id===id);
  if(!c) return;
  state.clienteSelecionadoId = id;
  document.getElementById('clienteBusca').value = '';
  document.getElementById('clienteBusca').style.display = 'none';
  document.getElementById('clienteDropdown').classList.remove('show');
  const chip = document.getElementById('clienteChip');
  chip.classList.add('show');
  chip.innerHTML = `<span>${c.nome} <small style="color:var(--ink-soft); font-weight:600;">#${c.codigo}</small></span><button id="clienteLimpar">✕</button>`;
  document.getElementById('clienteLimpar').onclick = limparClienteSelecionado;
}
function limparClienteSelecionado(){
  state.clienteSelecionadoId = null;
  const chip = document.getElementById('clienteChip');
  chip.classList.remove('show'); chip.innerHTML='';
  document.getElementById('clienteBusca').style.display = 'block';
  document.getElementById('clienteBusca').value = '';
}
document.getElementById('clienteBusca').addEventListener('input', (e)=> renderClienteDropdown(e.target.value));
document.getElementById('clienteDropdown').addEventListener('click', (e)=>{
  const item = e.target.closest('.cliente-dropdown-item');
  if(!item || !item.dataset.id) return;
  selecionarCliente(item.dataset.id);
});
document.addEventListener('click', (e)=>{
  if(!e.target.closest('.cliente-busca-wrap')){
    document.getElementById('clienteDropdown').classList.remove('show');
  }
});

/* ---------------- Estoque ---------------- */
function renderEstoque(){
  const lista = document.getElementById('listaEstoque');
  if(state.produtos.length===0){
    lista.innerHTML = `<div class="empty-state">Nenhum produto cadastrado. Clique em "+ Novo produto".</div>`;
    return;
  }

  // Obter filtro atual
  const filtro = document.getElementById('filtroEstoque')?.value || 'nome-asc';

  // Aplicar ordenação baseada no filtro
  const busca = normalizar(document.getElementById('buscaEstoque')?.value || '');
  let produtosOrdenados = state.produtos.filter(p=>!busca || [p.nome,p.codigo,p.codigoBarras].some(v=>normalizar(v).includes(busca)));
  switch(filtro){
    case 'nome-asc':
      produtosOrdenados.sort((a,b)=>a.nome.localeCompare(b.nome));
      break;
    case 'nome-desc':
      produtosOrdenados.sort((a,b)=>b.nome.localeCompare(a.nome));
      break;
    case 'preco-asc':
      produtosOrdenados.sort((a,b)=>a.preco - b.preco);
      break;
    case 'preco-desc':
      produtosOrdenados.sort((a,b)=>b.preco - a.preco);
      break;
    case 'qtd-asc':
      produtosOrdenados.sort((a,b)=>a.estoque - b.estoque);
      break;
    case 'qtd-desc':
      produtosOrdenados.sort((a,b)=>b.estoque - a.estoque);
      break;
    case 'validade-asc':
      produtosOrdenados.sort((a,b)=>compararValidade(a,b,false));
      break;
    case 'validade-desc':
      produtosOrdenados.sort((a,b)=>compararValidade(a,b,true));
      break;
  }

  if(produtosOrdenados.length===0){
    lista.innerHTML = `<div class="empty-state">Nenhum item encontrado para a pesquisa.</div>`;
    setupVisualMotion();
    return;
  }
  lista.innerHTML = produtosOrdenados.map(p=>{
    const low = p.estoque <= p.minimo;
    const validade = p.dataVencimento ? new Date(`${p.dataVencimento}T00:00:00`).toLocaleDateString('pt-BR') : '';
    const validadeProxima = dataValidadeProxima(p.dataVencimento);
    return `<div class="row-card ${validadeProxima?'validade-proxima':''}" data-id="${p.id}">
      <div class="main-info">
        <b>${p.nome}</b>
        <small>#${p.codigo} · ${fmt(p.preco)} / ${p.unidade} · mínimo ${p.minimo} ${p.unidade}${p.codigoBarras?(' · cód. barras '+p.codigoBarras):''}</small>
        ${validade ? `<small>Vencimento: ${validade}</small>` : '<span class="validade-ausente">Sem data de vencimento cadastrada</span>'}
      </div>
      <span class="badge ${low?'low':'ok'}">${p.estoque.toFixed(p.unidade==='kg'?1:0)} ${p.unidade}</span>
      <div class="row-actions">
        <button class="btn-ghost" data-act="editar">Editar</button>
        <button class="btn-ghost btn-danger" data-act="excluir">Excluir</button>
      </div>
    </div>`;
  }).join('');
  setupVisualMotion();
}
function dataValidadeProxima(dataVencimento){
  if(!dataVencimento) return false;
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const vencimento = new Date(`${dataVencimento}T00:00:00`);
  const limite = new Date(hoje); limite.setDate(limite.getDate()+45);
  return vencimento <= limite;
}
function compararValidade(a,b,inverter){
  const dataA = a.dataVencimento ? new Date(`${a.dataVencimento}T00:00:00`).getTime() : null;
  const dataB = b.dataVencimento ? new Date(`${b.dataVencimento}T00:00:00`).getTime() : null;
  if(dataA === null && dataB === null) return 0;
  if(dataA === null) return 1;
  if(dataB === null) return -1;
  return (dataA - dataB) * (inverter ? -1 : 1);
}
document.getElementById('filtroEstoque').addEventListener('change', renderEstoque);
document.getElementById('buscaEstoque').addEventListener('input', renderEstoque);
function formProdutoHTML(p){
  return `<div class="glass form-card">
    <label class="field">Código<input type="text" id="f_codigo" value="${p?p.codigo:proximoCodigo()}"></label>
    <label class="field">Código de barras<input type="text" id="f_barras" value="${p?p.codigoBarras||'':''}" placeholder="opcional"></label>
    <label class="field">Nome<input type="text" id="f_nome" value="${p?p.nome:''}"></label>
    <label class="field">Preço (R$)<input type="number" step="0.01" id="f_preco" value="${p?p.preco:''}"></label>
    <label class="field">Custo (R$)<input type="number" step="0.01" id="f_custo" value="${p?p.custo||'':''}"></label>
    <label class="field">Unidade
      <select id="f_unidade">
        <option value="kg" ${p&&p.unidade==='kg'?'selected':''}>kg</option>
        <option value="un" ${p&&p.unidade==='un'?'selected':''}>un</option>
      </select>
    </label>
    <label class="field">Quantidade em estoque<input type="number" step="0.01" id="f_estoque" value="${p?p.estoque:''}"></label>
    <label class="field">Data de vencimento<input type="date" id="f_vencimento" value="${p?p.dataVencimento||'':''}"></label>
    <label class="field">Estoque mínimo<input type="number" step="0.01" id="f_minimo" value="${p?p.minimo:2}"></label>
    <div style="display:flex; gap:8px;">
      <button class="btn-primary" id="f_salvar" style="flex:1;">Salvar</button>
      <button class="btn-ghost" id="f_cancelar">Cancelar</button>
    </div>
  </div>`;
}
let editandoProdutoId = null;
let notasXMLPendentes = [];
function elementosXML(node, tag){
  if(!node) return [];
  return Array.from(node.getElementsByTagName('*')).filter(el=>{
    const nome = el.localName || el.nodeName.split(':').pop();
    return nome === tag;
  });
}
function primeiroXML(node, tag){ return elementosXML(node, tag)[0] || null; }
function textoXML(node, tag){ const el = primeiroXML(node, tag); return el ? el.textContent.trim() : ''; }
function numeroXML(node, tag){
  const valor = textoXML(node, tag).replace(',', '.');
  const numero = parseFloat(valor);
  return Number.isFinite(numero) ? numero : 0;
}
async function lerNotaXML(arquivo){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(e){
      try{
        const conteudo = e.target.result;
        const xml = new DOMParser().parseFromString(conteudo, 'text/xml');

        const parserError = xml.querySelector('parsererror');
        if(parserError){
          return reject(new Error('XML inválido: ' + parserError.textContent));
        }

        const dets = elementosXML(xml, 'det');
        if(!dets.length) return reject(new Error('Nenhum item encontrado na nota.'));

        const ide = primeiroXML(xml, 'ide') || xml;
        const emit = primeiroXML(xml, 'emit') || xml;
        const duplicata = primeiroXML(xml, 'dup');
        const totalNode = primeiroXML(xml, 'ICMSTot') || xml;
        const chave = textoXML(xml,'chNFe') || `${textoXML(emit,'CNPJ') || textoXML(emit,'CPF')}|${textoXML(ide,'nNF')}|${textoXML(ide,'serie')}`;

        const tributacao = {};
        if(totalNode){
          tributacao.vICMS = numeroXML(totalNode,'vICMS');
          tributacao.vPIS = numeroXML(totalNode,'vPIS');
          tributacao.vCOFINS = numeroXML(totalNode,'vCOFINS');
          tributacao.vII = numeroXML(totalNode,'vII');
          tributacao.vIPI = numeroXML(totalNode,'vIPI');
          tributacao.vTotTrib = numeroXML(totalNode,'vTotTrib');
        }

        const itens = dets.map((det, index)=>{
          const prod = primeiroXML(det, 'prod') || det;
          const imposto = primeiroXML(det, 'imposto') || det;
          const icmsNode = primeiroXML(imposto, 'ICMS');
          const pisNode = primeiroXML(imposto, 'PIS');
          const cofinsNode = primeiroXML(imposto, 'COFINS');
          const qtd = parseFloat(textoXML(prod,'qCom').replace(',','.')) || 1;
          const valorUnitario = parseFloat(textoXML(prod,'vUnCom').replace(',','.')) || 0;
          return {
            id: uid(),
            nome:textoXML(prod,'xProd') || 'Item ' + (index+1),
            qtd: qtd,
            valorUnitario: valorUnitario,
            unidade:textoXML(prod,'uCom') || 'un',
            codigoBarras:textoXML(prod,'cEAN') || '',
            origem:textoXML(icmsNode,'orig') || '0',
            cst:textoXML(icmsNode,'CST') || textoXML(icmsNode,'CSOSN') || '900',
            pICMS:textoXML(icmsNode,'pICMS') || '0',
            vICMS:textoXML(icmsNode,'vICMS') || '0',
            pPIS:textoXML(pisNode,'pPIS') || '0',
            vPIS:textoXML(pisNode,'vPIS') || '0',
            pCOFINS:textoXML(cofinsNode,'pCOFINS') || '0',
            vCOFINS:textoXML(cofinsNode,'vCOFINS') || '0'
          };
        });

        resolve({
          arquivo, chave, numero:textoXML(ide,'nNF') || '—', serie:textoXML(ide,'serie') || '—',
          empresa:textoXML(emit,'xNome') || 'Empresa não informada', cnpj:textoXML(emit,'CNPJ') || textoXML(emit,'CPF') || '—',
          emissao:textoXML(ide,'dhEmi') || textoXML(ide,'dEmi') || '—',
          vencimento: textoXML(duplicata,'dVenc'),
          valor:parseFloat(textoXML(totalNode,'vNF').replace(',','.')) || itens.reduce((s,i)=>s+i.qtd*i.valorUnitario,0),
          itens, tributacao,
          duplicada:false
        });
      }catch(err){
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Erro ao ler o arquivo XML.'));
    reader.readAsText(arquivo);
  });
}
function formatarDataXML(valor){
  if(!valor || valor==='—') return 'Não informada';
  const data = new Date(valor); return isNaN(data) ? valor : data.toLocaleDateString('pt-BR');
}
function dataXMLParaInput(valor){
  if(!valor || valor==='—') return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? '' : dataLocalISO(data);
}
function renderPreviaXML(){
  const validas = notasXMLPendentes.filter(n=>!n.duplicada);

  const avisoEl = document.getElementById('xmlPreviewAviso');
  const conteudoEl = document.getElementById('xmlPreviewConteudo');
  const confirmarEl = document.getElementById('xmlPreviewConfirmar');

  if(!avisoEl || !conteudoEl || !confirmarEl) return;

  avisoEl.textContent = validas.length
    ? `${validas.length} nota(s) pronta(s) para importação. Notas duplicadas não serão importadas.`
    : 'Todas as notas selecionadas já foram importadas ou não são válidas.';
  conteudoEl.innerHTML = notasXMLPendentes.map(n=>`
    <div class="xml-nota-card ${n.duplicada?'duplicada':''}" data-nota-chave="${n.chave}">
      <div class="xml-nota-cabecalho">
        <div class="xml-nota-fornecedor">
          <b>Fornecedor: ${n.empresa}</b>
          <small>
            <div class="xml-fornecedor-meta">
              <span class="xml-meta-item"><span class="label">CNPJ/CPF</span><span class="valor">${n.cnpj}</span></span>
              <span class="xml-meta-item"><span class="label">NF</span><span class="valor">${n.numero}</span></span>
              <span class="xml-meta-item"><span class="label">Série</span><span class="valor">${n.serie}</span></span>
            </div>
            <div class="xml-fornecedor-meta" style="margin-top:4px;">
              <span class="xml-meta-item"><span class="label">Emissão</span><span class="valor">${formatarDataXML(n.emissao)}</span></span>
            </div>
          </small>
        </div>
        <div class="xml-nota-rodape" style="flex-direction:column; align-items:flex-end; gap:4px; margin-left:10px;">
          <div class="xml-total">${fmt(n.valor)} <small>Faturamento</small></div>
          <span class="xml-itens-contagem">${n.itens.length} item(ns)</span>
        </div>
      </div>
      <div class="xml-nota-tributacao">
        <div class="xml-trib-item"><span class="trib-label">ICMS</span><span class="trib-valor">${fmt(n.tributacao.vICMS || 0)}</span></div>
        <div class="xml-trib-item"><span class="trib-label">PIS</span><span class="trib-valor">${fmt(n.tributacao.vPIS || 0)}</span></div>
        <div class="xml-trib-item"><span class="trib-label">COFINS</span><span class="trib-valor">${fmt(n.tributacao.vCOFINS || 0)}</span></div>
        <div class="xml-trib-item"><span class="trib-label">II</span><span class="trib-valor">${fmt(n.tributacao.vII || 0)}</span></div>
        <div class="xml-trib-item"><span class="trib-label">IPI</span><span class="trib-valor">${fmt(n.tributacao.vIPI || 0)}</span></div>
        <div class="xml-trib-item"><span class="trib-label">Tot. Trib.</span><span class="trib-valor">${fmt(n.tributacao.vTotTrib || 0)}</span></div>
      </div>
      <div class="xml-nota-chave">
        <span>Chave de acesso:</span>
        <span>${n.chave}</span>
        <button class="copiar-btn" onclick="copiarChave('${n.chave}')">Copiar</button>
      </div>
      <ul class="xml-itens-lista">${n.itens.map((i, idx)=>`
        <li data-idx="${idx}" data-nota-chave="${n.chave}">
          <div class="editavel">
            <input type="text" class="nome" value="${i.nome}" placeholder="Nome">
            <input type="number" step="0.001" class="qtd" value="${i.qtd}" placeholder="Qtd">
            <input type="text" class="unidade" value="${i.unidade}" placeholder="Unid">
            <input type="number" step="0.01" class="valor" value="${i.valorUnitario}" placeholder="Valor">
            <input type="text" class="cod" value="${i.codigoBarras}" placeholder="Código">
          </div>
          <div class="actions">
            <button class="salvar" onclick="salvarItemEdicao(this)">✓</button>
            <button class="cancelar" onclick="cancelarItemEdicao(this)">✕</button>
          </div>
        </li>
      `).join('')}</ul>
    </div>`).join('');
  document.getElementById('xmlPreviewConfirmar').disabled = validas.length===0;
}

function copiarChave(chave){
  navigator.clipboard.writeText(chave).then(()=>{
    toast('Chave copiada!');
  });
}

function salvarItemEdicao(btn){
  const li = btn.closest('li');
  if(!li) return;
  const idx = li.dataset.idx;
  if(idx === undefined) return;

  // Encontrar a nota à qual o item pertence
  const notaChave = li.dataset.notaChave;
  const nota = notasXMLPendentes.find(n => n.chave === notaChave);
  if(!nota) return;

  // Verificar se o índice é válido
  if(idx < 0 || idx >= nota.itens.length) return;

  const item = nota.itens[idx];
  const inputs = li.querySelectorAll('.editavel input');
  if(inputs.length < 5) return;

  item.nome = inputs[0].value.trim();
  item.qtd = parseFloat(inputs[1].value) || 0;
  item.unidade = inputs[2].value.trim() || 'un';
  item.valorUnitario = parseFloat(inputs[3].value) || 0;
  item.codigoBarras = inputs[4].value.trim();

  // Atualizar o DOM sem recriar tudo (mantendo foco)
  li.querySelector('.nome').value = item.nome;
  li.querySelector('.qtd').value = item.qtd;
  li.querySelector('.unidade').value = item.unidade;
  li.querySelector('.valor').value = item.valorUnitario;
  li.querySelector('.cod').value = item.codigoBarras;

  toast('Item atualizado!');
}

function cancelarItemEdicao(btn){
  // Recarrega a prévia sem perder o estado das notas
  renderPreviaXML();
}

// Botão de importação XML
document.getElementById('xmlImportInput').addEventListener('change', async function(e){
  const arquivos = Array.from(e.target.files || []);
  e.target.value = ''; // Limpar input para permitir selecionar mesmo arquivo novamente
  if(!arquivos.length) return;

  notasXMLPendentes = [];
  const erros = [];

  for(const arquivo of arquivos){
    try{
      const nota = await lerNotaXML(arquivo);
      // Verificar duplicação
      nota.duplicada = state.notasImportadas.some(n => n.chave === nota.chave) ||
                       notasXMLPendentes.some(n => n.chave === nota.chave);
      notasXMLPendentes.push(nota);
    }catch(err){
      erros.push(`${arquivo.name}: ${err.message}`);
    }
  }

  if(notasXMLPendentes.length === 0){
    toast(erros.join(' · ') || 'Não foi possível ler a nota.');
    return;
  }

  renderPreviaXML();
  document.getElementById('xmlPreviewModal').classList.add('show');

  if(erros.length > 0){
    toast(`${erros.length} arquivo(s) não puderam ser lidos.`);
  }
});

// Botão de cancelar
document.getElementById('xmlPreviewCancelar').addEventListener('click', function(){
  notasXMLPendentes = [];
  document.getElementById('xmlPreviewModal').classList.remove('show');
});

// Botão de confirmar importação
document.getElementById('xmlPreviewConfirmar').addEventListener('click', async function(){
  if(notasXMLPendentes.length === 0){
    toast('Nenhuma nota para importar.');
    return;
  }

  const novas = notasXMLPendentes.filter(n => !n.duplicada);

  if(novas.length === 0){
    toast('Todas as notas já foram importadas anteriormente.');
    return;
  }

  try{
    for(const nota of novas){
      await importarNotaXML(nota);
    }
    await Promise.all([saveProdutos(), saveNotasImportadas(), saveBoletos()]);
    renderEstoque();
    renderProdutos();
    renderBoletos();
    renderNotasImportadas();
    document.getElementById('xmlPreviewModal').classList.remove('show');
    notasXMLPendentes = [];
    toast(`${novas.length} nota(s) importada(s) com sucesso!`);
  }catch(err){
    console.error('Erro ao importar:', err);
    toast('Erro ao importar notas. Verifique o console.');
  }
});

async function importarNotaXML(nota){
  const movimentos = [];
  for(const item of nota.itens){
    const unidade = item.unidade.toLowerCase().includes('kg') ? 'kg' : 'un';
    const existente = state.produtos.find(p =>
      (item.codigoBarras && p.codigoBarras === item.codigoBarras) ||
      normalizar(p.nome) === normalizar(item.nome)
    );
    if(existente){
      existente.estoque = +(existente.estoque + item.qtd).toFixed(3);
      if(item.valorUnitario > 0) existente.custo = item.valorUnitario;
      movimentos.push({produtoId:existente.id, codigo:existente.codigo, nome:existente.nome, unidade:existente.unidade, quantidade:item.qtd, custo:item.valorUnitario, produtoCriado:false});
    }else{
      const produtoNovo = {
        id: uid(),
        codigo: proximoCodigo(),
        codigoBarras: item.codigoBarras || '',
        nome: item.nome,
        unidade: unidade,
        preco: item.valorUnitario,
        custo: item.valorUnitario,
        estoque: +item.qtd.toFixed(3),
        minimo: 2
      };
      state.produtos.push(produtoNovo);
      movimentos.push({produtoId:produtoNovo.id, codigo:produtoNovo.codigo, nome:produtoNovo.nome, unidade:produtoNovo.unidade, quantidade:item.qtd, custo:item.valorUnitario, produtoCriado:true});
    }
  }
  const notaImportada = {
    id:uid(),
    chave: nota.chave,
    numero: nota.numero,
    empresa: nota.empresa,
    emissao: nota.emissao,
    valor: nota.valor,
    vencimento: dataXMLParaInput(nota.vencimento) || dataLocalISO(new Date(Date.now()+30*24*60*60*1000)),
    importadaEm: new Date().toISOString(),
    itens: nota.itens.map(item=>({nome:item.nome, codigoBarras:item.codigoBarras || '', quantidade:item.qtd, unidade:item.unidade})),
    movimentos
  };
  state.notasImportadas.push(notaImportada);
  state.boletos.unshift({
    id:uid(), tipo:'pagar', notaId:notaImportada.id, codigoNota:nota.numero,
    fornecedor:nota.empresa, valor:nota.valor, vencimento:notaImportada.vencimento,
    pago:false, criadoEm:new Date().toISOString()
  });
}
function renderNotasImportadas(){
  const lista = document.getElementById('listaNotasImportadas');
  if(!lista) return;
  const busca = normalizar(document.getElementById('buscaNotasImportadas')?.value || '');
  const notas = state.notasImportadas.filter(n=>!busca || [n.empresa,n.numero,n.chave].some(v=>normalizar(v).includes(busca)));
  if(notas.length===0){
    lista.innerHTML = `<div class="empty-state">Nenhuma nota XML importada ainda.</div>`;
    return;
  }
  lista.innerHTML = [...notas].reverse().map(n=>`
    <div class="row-card nota-importada-card ${n.revertida?'nota-revertida':''}" data-id="${n.id || n.chave}">
      <div class="main-info">
        <b>${n.empresa}</b>
        <small>NF ${n.numero} · ${formatarDataXML(n.emissao)} · ${n.itens?.length || n.movimentos?.length || 0} item(ns)</small>
        ${n.revertida ? `<span class="nota-revertida-info">Entrada revertida por: ${n.revertidaPor} · ${formatarDataXML(n.revertidaEm)}</span>` : ''}
      </div>
      <strong>${fmt(n.valor)}</strong>
      ${n.revertida ? '<span class="boleto-pago">Entrada revertida</span>' : '<button class="btn-ghost btn-danger" data-act="reverter-nota">Reverter entrada</button>'}
    </div>`).join('');
}
document.getElementById('buscaNotasImportadas').addEventListener('input', renderNotasImportadas);
let notaParaReverter = null;
function abrirReversaoNota(nota){
  notaParaReverter = nota;
  const movimentos = movimentosDaNota(nota);
  const itens = movimentos.map(movimento=>{
    const produto = state.produtos.find(p=>p.id===movimento.produtoId);
    const nome = movimento.nome || produto?.nome || 'Produto não encontrado';
    const unidade = movimento.unidade || produto?.unidade || 'un';
    const entrada = Number(movimento.quantidade || 0);
    const vendido = vendasDoProdutoAposNota(nota, movimento);
    const atual = produto ? Number(produto.estoque || 0) : 0;
    return `<div class="reverter-nota-item"><div><b>${nome}</b><small>${movimento.codigo ? '#'+movimento.codigo+' · ' : ''}${entrada.toFixed(unidade==='kg'?3:0)} ${unidade} entraram</small></div><span>Vendido: ${vendido.toFixed(unidade==='kg'?3:0)} ${unidade}<br><strong>Atual: ${atual.toFixed(unidade==='kg'?3:0)} ${unidade}</strong></span></div>`;
  }).join('');
  document.getElementById('reverterNotaPrevia').innerHTML = `<b>${nota.empresa}</b><span>NF ${nota.numero} · ${formatarDataXML(nota.emissao)}</span><strong>${fmt(nota.valor)}</strong><div class="reverter-nota-itens">${itens || '<span>Itens desta nota não foram rastreados.</span>'}</div><small>Após confirmar, a quantidade entrada será retirada do estoque atual.</small>`;
  document.getElementById('reverterNotaConfirmacao').checked = false;
  document.getElementById('reverterNotaSenha').value = '';
  document.getElementById('reverterNotaErro').style.display = 'none';
  document.getElementById('reverterNotaModal').classList.add('show');
  setTimeout(()=>document.getElementById('reverterNotaSenha').focus(), 60);
}
function movimentosDaNota(nota){
  if(nota.movimentos?.length) return nota.movimentos;
  return (nota.itens || []).map(item=>{
    const produto = state.produtos.find(p=>
      (item.codigoBarras && p.codigoBarras === item.codigoBarras) || normalizar(p.nome) === normalizar(item.nome)
    );
    return {produtoId:produto?.id, codigo:produto?.codigo, nome:item.nome, unidade:item.unidade, quantidade:Number(item.quantidade || item.qtd || 0), produtoCriado:false};
  });
}
function vendasDoProdutoAposNota(nota, movimento){
  const inicio = new Date(nota.importadaEm || 0).getTime();
  return state.vendas.filter(v=>!v.cancelada && new Date(v.data || 0).getTime() >= inicio).reduce((total, venda)=>total + (venda.itens || []).filter(item=>
    (item.produtoId && item.produtoId === movimento.produtoId) ||
    (!item.produtoId && ((movimento.nome && item.nome === movimento.nome) || (movimento.codigo && item.codigo === movimento.codigo)))
  ).reduce((subtotal, item)=>subtotal + Number(item.qtd || 0), 0), 0);
}
document.getElementById('listaNotasImportadas').addEventListener('click', async e=>{
  const botao = e.target.closest('[data-act="reverter-nota"]');
  if(!botao) return;
  const card = botao.closest('.nota-importada-card');
  const nota = state.notasImportadas.find(n=>(n.id || n.chave)===card.dataset.id);
  if(!nota || nota.revertida) return;
  abrirReversaoNota(nota);
});
document.getElementById('reverterNotaCancelar').addEventListener('click', ()=>{
  notaParaReverter = null;
  document.getElementById('reverterNotaModal').classList.remove('show');
});
document.getElementById('reverterNotaConfirmar').addEventListener('click', async ()=>{
  const nota = notaParaReverter;
  const erro = document.getElementById('reverterNotaErro');
  if(!nota) return;
  if(!document.getElementById('reverterNotaConfirmacao').checked){
    erro.textContent = 'Marque a confirmação para continuar.'; erro.style.display = 'block'; return;
  }
  const senha = document.getElementById('reverterNotaSenha').value;
  if(!state.vendedorLogado || senha !== state.vendedorLogado.senha){
    erro.textContent = 'Senha do vendedor incorreta.'; erro.style.display = 'block'; return;
  }
  movimentosDaNota(nota).forEach(movimento=>{
    const produto = state.produtos.find(p=>p.id===movimento.produtoId);
    if(!produto) return;
    produto.estoque = Math.max(0, +(produto.estoque - movimento.quantidade).toFixed(3));
    if(movimento.produtoCriado && produto.estoque <= 0){
      state.produtos = state.produtos.filter(p=>p.id!==produto.id);
    }
  });
  nota.revertida = true;
  nota.revertidaPor = state.vendedorLogado.nome;
  nota.revertidaEm = new Date().toISOString();
  state.boletos = state.boletos.map(b=>b.notaId===nota.id ? {...b, cancelado:true, canceladoPor:nota.revertidaPor} : b);
  await Promise.all([saveProdutos(), saveNotasImportadas(), saveBoletos()]);
  renderEstoque(); renderProdutos(); renderBoletos(); renderNotasImportadas();
  notaParaReverter = null;
  document.getElementById('reverterNotaModal').classList.remove('show');
  toast('Entrada da nota revertida e estoque atualizado.');
});
document.getElementById('novoProdutoBtn').addEventListener('click', ()=>{
  editandoProdutoId = null;
  const box = document.getElementById('formProduto');
  box.style.display='block'; box.innerHTML = formProdutoHTML(null); bindFormProduto();
});
let produtoParaExcluirId = null;

document.getElementById('listaEstoque').addEventListener('click', (e)=>{
  const row = e.target.closest('.row-card'); if(!row) return;
  const id = row.dataset.id; const act = e.target.dataset.act;
  if(act==='editar'){
    editandoProdutoId = id;
    const p = state.produtos.find(x=>x.id===id);
    const box = document.getElementById('formProduto');
    box.style.display='block'; box.innerHTML = formProdutoHTML(p); bindFormProduto();
  } else if(act==='excluir'){
    produtoParaExcluirId = id;
    document.getElementById('excluirProdutoModal').classList.add('show');
  }
});

document.getElementById('excluirProdutoVoltar').addEventListener('click', ()=>{
  produtoParaExcluirId = null;
  document.getElementById('excluirProdutoModal').classList.remove('show');
});

document.getElementById('excluirProdutoConfirmar').addEventListener('click', ()=>{
  if(produtoParaExcluirId){
    state.produtos = state.produtos.filter(p=>p.id!==produtoParaExcluirId);
    saveProdutos();
    renderEstoque();
    renderProdutos();
    toast('Produto excluído.');
  }
  produtoParaExcluirId = null;
  document.getElementById('excluirProdutoModal').classList.remove('show');
});
function bindFormProduto(){
  document.getElementById('f_cancelar').onclick = ()=>{ document.getElementById('formProduto').style.display='none'; };
  document.getElementById('f_salvar').onclick = async ()=>{
    const codigo = document.getElementById('f_codigo').value.trim();
    const codigoBarras = document.getElementById('f_barras').value.trim();
    const nome = document.getElementById('f_nome').value.trim();
    const preco = parseFloat(document.getElementById('f_preco').value);
    const custo = parseFloat(document.getElementById('f_custo').value) || 0;
    const unidade = document.getElementById('f_unidade').value;
    const estoque = parseFloat(document.getElementById('f_estoque').value);
    const dataVencimento = document.getElementById('f_vencimento').value;
    const minimo = parseFloat(document.getElementById('f_minimo').value);
    if(!nome || !codigo || isNaN(preco) || isNaN(estoque)){ toast('Preencha código, nome, preço e estoque corretamente.'); return; }
    const codigoDuplicado = state.produtos.find(x=>x.codigo===codigo && x.id!==editandoProdutoId);
    if(codigoDuplicado){ toast('Já existe um produto com esse código.'); return; }
    if(editandoProdutoId){
      const p = state.produtos.find(x=>x.id===editandoProdutoId);
      Object.assign(p, {codigo, codigoBarras, nome, preco, custo, unidade, estoque, dataVencimento, minimo: isNaN(minimo)?2:minimo});
    } else {
      state.produtos.push({ id:uid(), codigo, codigoBarras, nome, preco, custo, unidade, estoque, dataVencimento, minimo: isNaN(minimo)?2:minimo });
    }
    await saveProdutos();
    document.getElementById('formProduto').style.display='none';
    renderEstoque(); renderProdutos();
    toast('Produto salvo.');
  };
}

/* ---------------- Clientes ---------------- */
function nivelCliente(gastoTotal){
  if(gastoTotal >= 1500) return { nome:'Platinum', classe:'tier-platinum' };
  if(gastoTotal >= 800) return { nome:'Diamante', classe:'tier-diamante' };
  if(gastoTotal >= 300) return { nome:'Ouro', classe:'tier-ouro' };
  return null;
}
function resumoPagamentosCliente(clienteId){
  const grupos = {};
  state.vendas.filter(v=>v.clienteId===clienteId && !v.cancelada).forEach(v=>{
    const base = v.pagamento.split(' (')[0];
    grupos[base] = (grupos[base]||0) + v.total;
  });
  return grupos;
}
function renderClientes(){
  const lista = document.getElementById('listaClientes');
  if(state.clientes.length===0){
    lista.innerHTML = `<div class="empty-state">Nenhum cliente cadastrado ainda.</div>`;
    return;
  }
  lista.innerHTML = state.clientes.map(c=>{
    const gasto = state.vendas.filter(v=>v.clienteId===c.id && !v.cancelada).reduce((a,v)=>a+v.total,0);
    const nivel = nivelCliente(gasto);
    const grupos = resumoPagamentosCliente(c.id);
    const resumoStr = Object.entries(grupos).map(([forma,val])=>`${forma}: ${fmt(val)}`).join(' · ');
    const enderecoStr = [c.endereco, c.bairro, c.cidade].filter(Boolean).join(', ');
    return `<div class="row-card" data-id="${c.id}">
      <div class="main-info">
        <b>${c.nome} <span style="color:var(--ink-soft); font-weight:600; font-size:11.5px;">#${c.codigo}</span></b>
        <small>${c.telefone||'sem telefone'} ${c.email?(' · <a href="mailto:'+c.email+'" style="color:var(--vermelho); font-weight:700; text-decoration:underline;">'+c.email+'</a>'):''} ${c.obs?(' · '+c.obs):''}</small>
        ${enderecoStr ? `<span class="endereco-linha">📍 ${enderecoStr}</span>` : ''}
        ${resumoStr ? `<span class="compras-resumo">${resumoStr}</span>` : ''}
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
        <span class="badge ok">${fmt(gasto)} no total</span>
        ${nivel ? `<span class="tier-badge ${nivel.classe}">${nivel.nome}</span>` : ''}
      </div>
      <div class="row-actions">
        <button class="btn-ghost" data-act="editar">Editar</button>
        <button class="btn-ghost btn-danger" data-act="excluir">Excluir</button>
      </div>
    </div>`;
  }).join('');
}
function formClienteHTML(c){
  return `<div class="glass form-card">
    <label class="field">Nome<input type="text" id="c_nome" value="${c?c.nome:''}"></label>
    <label class="field">Telefone<input type="tel" id="c_tel" value="${c?c.telefone||'':''}" placeholder="(27) 99999-9999" maxlength="15"></label>
    <label class="field">E-mail<input type="text" id="c_email" value="${c?c.email||'':''}" placeholder="cliente@email.com"></label>
    <label class="field">Endereço (rua e número)<input type="text" id="c_endereco" value="${c?c.endereco||'':''}"></label>
    <label class="field">Bairro<input type="text" id="c_bairro" value="${c?c.bairro||'':''}"></label>
    <label class="field">Cidade<input type="text" id="c_cidade" value="${c?c.cidade||'':''}"></label>
    <label class="field full">Observações<input type="text" id="c_obs" value="${c?c.obs||'':''}"></label>
    <div style="display:flex; gap:8px;">
      <button class="btn-primary" id="c_salvar" style="flex:1;">Salvar</button>
      <button class="btn-ghost" id="c_cancelar">Cancelar</button>
    </div>
  </div>`;
}
let editandoClienteId = null;
document.getElementById('novoClienteBtn').addEventListener('click', ()=>{
  editandoClienteId = null;
  const box = document.getElementById('formCliente');
  box.style.display='block'; box.innerHTML = formClienteHTML(null); bindFormCliente();
});
document.getElementById('listaClientes').addEventListener('click', (e)=>{
  const row = e.target.closest('.row-card'); if(!row) return;
  const id = row.dataset.id; const act = e.target.dataset.act;
  if(act==='editar'){
    editandoClienteId = id;
    const c = state.clientes.find(x=>x.id===id);
    const box = document.getElementById('formCliente');
    box.style.display='block'; box.innerHTML = formClienteHTML(c); bindFormCliente();
  } else if(act==='excluir'){
    if(confirm('Excluir este cliente?')){
      state.clientes = state.clientes.filter(c=>c.id!==id);
      saveClientes(); renderClientes();
      toast('Cliente excluído.');
    }
  }
});
function maskTelefone(valor){
  let d = valor.replace(/\D/g,'').slice(0,11);
  if(d.length > 10){
    return d.replace(/^(\d{2})(\d{5})(\d{0,4}).*/, (m,p1,p2,p3)=> `(${p1}) ${p2}${p3?('-'+p3):''}`);
  } else if(d.length > 6){
    return d.replace(/^(\d{2})(\d{4})(\d{0,4}).*/, (m,p1,p2,p3)=> `(${p1}) ${p2}${p3?('-'+p3):''}`);
  } else if(d.length > 2){
    return d.replace(/^(\d{2})(\d{0,5}).*/, (m,p1,p2)=> `(${p1}) ${p2}`);
  } else if(d.length > 0){
    return d.replace(/^(\d*)/, (m,p1)=> `(${p1}`);
  }
  return '';
}
function bindFormCliente(){
  document.getElementById('c_tel').addEventListener('input', (e)=>{ e.target.value = maskTelefone(e.target.value); });
  document.getElementById('c_cancelar').onclick = ()=>{ document.getElementById('formCliente').style.display='none'; };
  document.getElementById('c_salvar').onclick = async ()=>{
    const nome = document.getElementById('c_nome').value.trim();
    const telefone = document.getElementById('c_tel').value.trim();
    const email = document.getElementById('c_email').value.trim();
    const endereco = document.getElementById('c_endereco').value.trim();
    const bairro = document.getElementById('c_bairro').value.trim();
    const cidade = document.getElementById('c_cidade').value.trim();
    const obs = document.getElementById('c_obs').value.trim();
    if(!nome){ toast('Informe o nome do cliente.'); return; }
    if(editandoClienteId){
      const c = state.clientes.find(x=>x.id===editandoClienteId);
      Object.assign(c, {nome, telefone, email, endereco, bairro, cidade, obs});
    } else {
      state.clientes.push({ id:uid(), codigo:proximoCodigoCliente(), nome, telefone, email, endereco, bairro, cidade, obs });
    }
    await saveClientes();
    document.getElementById('formCliente').style.display='none';
    renderClientes();
    toast('Cliente salvo.');
  };
}

/* ---------------- Vendedores ---------------- */
function avatarVendedorHTML(vd, classe='perfil-avatar'){
  return vd.foto ? `<img class="${classe}" src="${vd.foto}" alt="Foto de ${vd.nome}">` : `<span class="${classe}">${iniciais(vd.nome)}</span>`;
}
function atualizarPerfilVendedorLogado(){
  const vd=state.vendedorLogado; if(!vd) return;
  document.getElementById('vendedorNomeLabel').textContent=vd.nome;
  const avatar=document.getElementById('vendedorAvatar');
  if(vd.foto){ avatar.innerHTML=`<img src="${vd.foto}" alt="Foto de ${vd.nome}">`; avatar.classList.add('tem-foto'); }
  else { avatar.textContent=iniciais(vd.nome); avatar.classList.remove('tem-foto'); }
}
function renderVendedores(){
  const lista = document.getElementById('listaVendedores');
  if(state.vendedores.length===0){ lista.innerHTML = `<div class="empty-state">Nenhum vendedor cadastrado ainda.</div>`; return; }
  lista.innerHTML = state.vendedores.map(vd=>{
    const vendas = state.vendas.filter(v=>v.vendedorNome===vd.nome && !v.cancelada).length;
    return `<div class="row-card" data-id="${vd.id}">
      <div class="vendedor-info">${avatarVendedorHTML(vd)}<div class="main-info"><b>${vd.nome}</b><small>login: ${vd.username}${vd.email?` · ${vd.email}`:''}${vd.telefone?` · ${vd.telefone}`:''}</small></div></div>
      <span class="badge ok">${vendas} venda${vendas===1?'':'s'}</span>
      <div class="row-actions"><button class="btn-ghost" data-act="editar">Editar</button><button class="btn-ghost btn-danger" data-act="excluir">Excluir</button></div>
    </div>`;
  }).join('');
}
function formVendedorHTML(vd){
  const foto=vd&&vd.foto ? vd.foto : '';
  return `<div class="glass form-card">
    <label class="field">Nome<input type="text" id="vd_nome" value="${vd?vd.nome:''}"></label>
    <label class="field">Usuário<input type="text" id="vd_user" value="${vd?vd.username:''}"></label>
    <label class="field">E-mail<input type="email" id="vd_email" value="${vd?vd.email||'':''}" placeholder="vendedor@empresa.com" autocomplete="email" inputmode="email"></label>
    <label class="field">Telefone<input type="tel" id="vd_telefone" value="${vd?vd.telefone||'':''}"></label>
    ${vd ? `<label class="field full"><span><input type="checkbox" id="vd_alterar_senha"> Alterar senha</span></label>
    <div id="vd_campos_senha" class="senha-alteracao" style="display:none;">
      <label class="field">Senha antiga<input type="password" id="vd_senha_antiga"></label>
      <label class="field">Nova senha<input type="password" id="vd_senha_nova"></label>
      <label class="field">Repita a nova senha<input type="password" id="vd_senha_confirmacao"></label>
    </div>` : `<label class="field">Senha<input type="password" id="vd_senha"></label>`}
    <div style="grid-column:1/-1; display:flex; flex-direction:column; gap:6px;">
      <label class="field" style="margin:0;">Foto do perfil</label>
      <div class="foto-vendedor-campo" style="flex-wrap:wrap;">
        <img class="foto-vendedor-preview" id="vd_foto_preview" src="${foto || 'logo.png'}" alt="Prévia da foto" style="flex:0 0 56px;">
        <input type="file" id="vd_foto" accept="image/png,image/jpeg,image/webp" style="flex:1;">
      </div>
    </div>
    <div style="grid-column:1/-1; display:flex; gap:8px;">
      <button class="btn-primary" id="vd_salvar" style="flex:1;">Salvar</button>
      <button class="btn-ghost" id="vd_cancelar">Cancelar</button>
    </div>
  </div>`;
}
let editandoVendedorId = null;
let fotoVendedorPendente = '';
document.getElementById('novoVendedorBtn').addEventListener('click', ()=>{ editandoVendedorId=null; fotoVendedorPendente=''; const box=document.getElementById('formVendedor'); box.style.display='block'; box.innerHTML=formVendedorHTML(null); bindFormVendedor(); });
document.getElementById('listaVendedores').addEventListener('click', e=>{
  const row=e.target.closest('.row-card'); if(!row) return; const id=row.dataset.id; const act=e.target.dataset.act;
  if(act==='editar'){ editandoVendedorId=id; const vd=state.vendedores.find(x=>x.id===id); fotoVendedorPendente=vd.foto||''; const box=document.getElementById('formVendedor'); box.style.display='block'; box.innerHTML=formVendedorHTML(vd); bindFormVendedor(); }
  else if(act==='excluir'){ if(state.vendedores.length<=1){toast('É preciso manter ao menos um vendedor cadastrado.');return;} if(confirm('Excluir este vendedor?')){state.vendedores=state.vendedores.filter(v=>v.id!==id); saveVendedores(); renderVendedores(); toast('Vendedor excluído.');} }
});
function bindFormVendedor(){
  document.getElementById('vd_cancelar').onclick=()=>{document.getElementById('formVendedor').style.display='none';};
  document.getElementById('vd_foto').addEventListener('change',async e=>{
    const arquivo=e.target.files[0]; if(!arquivo) return;
    if(arquivo.size>2*1024*1024){toast('Escolha uma foto de até 2 MB.'); e.target.value=''; return;}
    fotoVendedorPendente=await lerImagemComoDataURL(arquivo); document.getElementById('vd_foto_preview').src=fotoVendedorPendente;
  });
  const alterarSenha = document.getElementById('vd_alterar_senha');
  if(alterarSenha) alterarSenha.onchange = ()=>{ document.getElementById('vd_campos_senha').style.display = alterarSenha.checked ? 'grid' : 'none'; };
  document.getElementById('vd_salvar').onclick=async()=>{
    const nome=document.getElementById('vd_nome').value.trim(), username=document.getElementById('vd_user').value.trim().toLowerCase();
    const email=document.getElementById('vd_email').value.trim().toLowerCase(), telefone=document.getElementById('vd_telefone').value.trim();
    const senhaNova = document.getElementById('vd_senha_nova')?.value || '';
    const senha = document.getElementById('vd_senha')?.value || '';
    if(!nome||!username||(!editandoVendedorId&&!senha)){toast('Preencha nome, usuário e senha.');return;}
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('Informe um e-mail válido.');return;}
    if(state.vendedores.some(v=>v.username===username&&v.id!==editandoVendedorId)){toast('Já existe um vendedor com esse usuário.');return;}
    if(state.vendedores.some(v=>(email&&v.email===email || telefone&&v.telefone===telefone)&&v.id!==editandoVendedorId)){toast('E-mail ou telefone já está em uso.');return;}
    if(editandoVendedorId){
      const vd=state.vendedores.find(x=>x.id===editandoVendedorId);
      let senhaAtual = vd.senha;
      if(alterarSenha?.checked){
        if(document.getElementById('vd_senha_antiga').value !== vd.senha){toast('Senha antiga incorreta.');return;}
        if(!senhaNova || senhaNova !== document.getElementById('vd_senha_confirmacao').value){toast('As novas senhas não conferem.');return;}
        senhaAtual = senhaNova;
      }
      Object.assign(vd,{nome,username,email,telefone,senha:senhaAtual,foto:fotoVendedorPendente}); if(state.vendedorLogado&&state.vendedorLogado.id===vd.id) atualizarPerfilVendedorLogado();
    } else state.vendedores.push({id:uid(),nome,username,email,telefone,senha,foto:fotoVendedorPendente});
    await saveVendedores(); document.getElementById('formVendedor').style.display='none'; renderVendedores(); toast('Vendedor salvo.');
  };
}

/* ---------------- Login ---------------- */
function iniciais(nome){
  return nome.trim().split(/\s+/).slice(0,2).map(p=>p[0].toUpperCase()).join('');
}
function mostrarApp(){
  const wrapper = document.getElementById('appWrapper');
  atualizarPerfilVendedorLogado();
  wrapper.style.display = 'block';
  wrapper.classList.remove('fade-in-app');
  void wrapper.offsetWidth; // reinicia a animação
  wrapper.classList.add('fade-in-app');
}
function tocarTelaCarregamento(callback){
  const loading = document.getElementById('loadingScreen');
  const logo = document.getElementById('loadingLogo');
  const shine = document.getElementById('shineEl');
  const message = document.getElementById('loadingMessage');
  if (!loading || !logo || !shine || !message) {
    callback();
    return;
  }

  const frases = [
    'Carregando banco de dados...',
    'Sincronizando estoque e preços...',
    'Validando caixa e pagamentos...',
    'Preparando dashboard da operação...',
    'Conectando a loja com o PDV...'
  ];

  loading.style.display = 'flex';
  logo.style.animation = 'none';
  shine.style.animation = 'none';
  void logo.offsetWidth;
  logo.style.animation = '';
  shine.style.animation = '';

  let indice = 0;
  const interval = setInterval(() => {
    indice = (indice + 1) % frases.length;
    message.textContent = frases[indice];
  }, 450);

  message.textContent = frases[0];

  setTimeout(() => {
    clearInterval(interval);
    loading.style.display = 'none';
    callback();
  }, 2400);
}
async function tentarLogin(){
  const user = document.getElementById('loginUser').value.trim().toLowerCase();
  const senha = document.getElementById('loginSenha').value;
  const vd = state.vendedores.find(v=>(v.username.toLowerCase()===user || (v.email&&v.email.toLowerCase()===user) || (v.telefone&&v.telefone===user)) && v.senha===senha);
  const erro = document.getElementById('loginErro');
  if(!vd){
    erro.style.display='block';
    return;
  }
  erro.style.display='none';
  state.vendedorLogado = vd;
  await saveSnapshotPDV();
  document.getElementById('loginScreen').style.display = 'none';
  tocarTelaCarregamento(mostrarApp);
}
document.getElementById('loginBtn').addEventListener('click', tentarLogin);
document.getElementById('loginSenha').addEventListener('keydown', (e)=>{ if(e.key==='Enter') tentarLogin(); });
document.getElementById('loginUser').addEventListener('keydown', (e)=>{ if(e.key==='Enter') document.getElementById('loginSenha').focus(); });
document.getElementById('logoutBtn').addEventListener('click', async ()=>{
  state.vendedorLogado = null;
  await saveSnapshotPDV();
  document.getElementById('loginUser').value = '';
  document.getElementById('loginSenha').value = '';
  document.getElementById('appWrapper').classList.remove('fade-in-app');
  document.getElementById('appWrapper').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
});

/* ---------------- Histórico ---------------- */
function renderHistorico(){
  const lista = document.getElementById('listaVendas');
  const stat = document.getElementById('statRow');
  const hoje = new Date().toDateString();
  const vendasValidas = state.vendas.filter(v=>!v.cancelada);
  const vendasHoje = vendasValidas.filter(v=> new Date(v.data).toDateString()===hoje);
  const totalHoje = vendasHoje.reduce((a,v)=>a+v.total,0);
  const totalGeral = vendasValidas.reduce((a,v)=>a+v.total,0);
  stat.innerHTML = `
    <div class="glass stat"><span>Vendas hoje</span><b>${vendasHoje.length}</b></div>
    <div class="glass stat"><span>Faturado hoje</span><b>${fmt(totalHoje)}</b></div>
    <div class="glass stat"><span>Faturado no total</span><b>${fmt(totalGeral)}</b></div>
  `;
  if(state.vendas.length===0){
    lista.innerHTML = `<div class="empty-state">Nenhuma venda registrada ainda.</div>`;
    return;
  }
  lista.innerHTML = state.vendas.map(v=>{
    const d = new Date(v.data);
    const dataFmt = d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    const itensStr = v.itens.map(i=>`${i.nome} (${i.qtd}${i.unidade})`).join(', ');
    return `<div class="glass venda-hist" data-id="${v.id}" style="${v.cancelada?'opacity:0.55;':''}">
      <div class="toolbar" style="margin-bottom:0; align-items:flex-start;">
        <div>
          <b>${v.codigo||'—'}</b> · <b>${fmt(v.total)}</b> · ${v.pagamento}
          ${v.cancelada ? ' · <span style="color:var(--vermelho); font-weight:800;">CANCELADA</span>' : ''}
          <div class="itens-mini">Comprador: ${v.clienteNome||'Não identificado'} · Vendedor: ${v.vendedorNome||'—'}</div>
          <div class="itens-mini">${itensStr}</div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
          <small style="color:var(--ink-soft);">${dataFmt}</small>
          <div style="display:flex; gap:6px;">
            <button class="btn-ghost" data-act="refazer" style="padding:6px 10px; font-size:10.5px;">Comprovante</button>
            ${!v.cancelada ? `<button class="btn-ghost btn-danger" data-act="cancelar" style="padding:6px 10px; font-size:10.5px;">Cancelar</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}
function inicioPeriodoFaturamento(periodo){
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  if(periodo==='dia') return hoje;
  if(periodo==='mes') return new Date(hoje.getFullYear(),hoje.getMonth(),1);
  if(periodo==='trimestre') return new Date(hoje.getFullYear(),Math.floor(hoje.getMonth()/3)*3,1);
  if(periodo==='semestre') return new Date(hoje.getFullYear(),hoje.getMonth()<6?0:6,1);
  return new Date(hoje.getFullYear(),0,1);
}
function resumoFaturamento(vendas){
  const itens = {};
  vendas.forEach(v=>(v.itens||[]).forEach(item=>{
    const chave = item.produtoId || item.codigo || item.nome;
    const custo = Number(item.custo ?? state.produtos.find(p=>p.id===item.produtoId)?.custo ?? 0);
    const receita = Number(item.qtd||0) * Number(item.preco||0);
    const lucro = receita - Number(item.qtd||0) * custo;
    if(!itens[chave]) itens[chave] = {nome:item.nome, unidade:item.unidade, quantidade:0, receita:0, custo:0, lucro:0};
    itens[chave].quantidade += Number(item.qtd||0); itens[chave].receita += receita;
    itens[chave].custo += Number(item.qtd||0) * custo; itens[chave].lucro += lucro;
  }));
  return Object.values(itens).sort((a,b)=>b.lucro-a.lucro);
}
function renderFaturamento(){
  const periodo = document.getElementById('faturamentoPeriodo')?.value || 'dia';
  const personalizado = periodo === 'personalizado';
  const blocoPersonalizado = document.getElementById('faturamentoPersonalizado');
  if(blocoPersonalizado) blocoPersonalizado.style.display = personalizado ? 'flex' : 'none';
  const inicio = personalizado ? new Date(`${document.getElementById('faturamentoDataInicial').value || '9999-12-31'}T00:00:00`) : inicioPeriodoFaturamento(periodo);
  const dataFinal = personalizado ? document.getElementById('faturamentoDataFinal').value : '';
  const fim = dataFinal ? new Date(`${dataFinal}T23:59:59.999`) : null;
  const vendas = state.vendas.filter(v=>!v.cancelada && new Date(v.data)>=inicio && (!fim || new Date(v.data)<=fim));
  const itens = resumoFaturamento(vendas);
  const receita = itens.reduce((s,i)=>s+i.receita,0), custo = itens.reduce((s,i)=>s+i.custo,0);
  document.getElementById('faturamentoStatRow').innerHTML = `<div class="glass stat"><span>Vendas</span><b>${vendas.length}</b></div><div class="glass stat"><span>Faturamento bruto</span><b>${fmt(receita)}</b></div><div class="glass stat"><span>Custo dos produtos</span><b>${fmt(custo)}</b></div><div class="glass stat lucro-stat"><span>Lucro bruto</span><b>${fmt(receita-custo)}</b></div>`;
  document.getElementById('listaFaturamento').innerHTML = itens.length ? itens.map(i=>`<div class="row-card"><div class="main-info"><b>${i.nome}</b><small>${i.quantidade.toFixed(i.unidade==='kg'?3:0)} ${i.unidade} vendidos · Receita ${fmt(i.receita)} · Custo ${fmt(i.custo)}</small></div><strong class="lucro-valor">Lucro: ${fmt(i.lucro)}</strong></div>`).join('') : '<div class="empty-state">Nenhuma venda no período selecionado.</div>';
}
document.getElementById('faturamentoPeriodo').addEventListener('change', renderFaturamento);
['faturamentoDataInicial','faturamentoDataFinal'].forEach(id=>document.getElementById(id).addEventListener('change', renderFaturamento));
let vendaParaCancelarId = null;
document.getElementById('listaVendas').addEventListener('click', (e)=>{
  const card = e.target.closest('.venda-hist'); if(!card) return;
  const venda = state.vendas.find(v=>v.id===card.dataset.id);
  if(!venda) return;
  const act = e.target.dataset.act;
  if(act==='refazer'){
    abrirComprovante(venda);
  } else if(act==='cancelar'){
    vendaParaCancelarId = venda.id;
    document.getElementById('cancelarVendaModal').classList.add('show');
  }
});
document.getElementById('cancelarVendaVoltar').addEventListener('click', ()=>{
  vendaParaCancelarId = null;
  document.getElementById('cancelarVendaModal').classList.remove('show');
});
document.getElementById('cancelarVendaConfirmar').addEventListener('click', async ()=>{
  const venda = state.vendas.find(v=>v.id===vendaParaCancelarId);
  document.getElementById('cancelarVendaModal').classList.remove('show');
  if(!venda) return;
  venda.itens.forEach(item=>{
    const prod = state.produtos.find(p=>p.nome===item.nome && p.unidade===item.unidade);
    if(prod) prod.estoque = +(prod.estoque + item.qtd).toFixed(3);
  });
  venda.cancelada = true;
  vendaParaCancelarId = null;
  await Promise.all([saveVendas(), saveProdutos()]);
  renderHistorico(); renderProdutos(); renderClientes(); renderVendasRecentes();
  toast('Venda cancelada e estoque devolvido.');
});

/* ---------------- Boletos ---------------- */
function statusBoleto(boleto){
  if(boleto.pago) return 'pago';
  return boleto.vencimento < dataLocalISO() ? 'vencido' : 'aberto';
}
function formatarDataBoleto(data){
  if(!data) return 'Sem vencimento';
  const [ano, mes, dia] = data.split('-');
  return `${dia}/${mes}/${ano}`;
}
function obterResumoFechamentoCaixa(){
  const totais = { Dinheiro: 0, Cartão: 0, Pix: 0, PicPay: 0, Fiado: 0 };
  state.vendas.filter(v => !v.cancelada).forEach(venda => {
    const texto = (venda.pagamento || '').toLowerCase();
    if(texto.includes('cartão')) totais.Cartão += Number(venda.total || 0);
    else if(texto.includes('pix')) totais.Pix += Number(venda.total || 0);
    else if(texto.includes('picpay')) totais.PicPay += Number(venda.total || 0);
    else if(texto.includes('fiado')) totais.Fiado += Number(venda.total || 0);
    else if(texto.includes('dinheiro')) totais.Dinheiro += Number(venda.total || 0);
  });
  const totalEntradas = Object.values(totais).reduce((s, n) => s + Number(n || 0), 0);
  return {
    ...totais,
    trocoCaixa: Number(state.caixa.trocoInicial ?? state.caixa.saldoInicial ?? 50),
    estoqueTroco: Number(state.caixa.estoqueTroco ?? 200),
    totalEntradas,
    saldoFinalPrevisto: Number(state.caixa.saldoInicial || 50) + totalEntradas
  };
}

function renderCaixa(){
  const stat = document.getElementById('caixaStatRow');
  const lista = document.getElementById('listaCaixaMovimentacoes');
  if(!stat || !lista) return;
  const entradas = state.caixa.movimentacoes.filter(m => Number(m.valor) >= 0).reduce((s, m) => s + Number(m.valor || 0), 0);
  const saidas = state.caixa.movimentacoes.filter(m => Number(m.valor) < 0).reduce((s, m) => s + Math.abs(Number(m.valor || 0)), 0);
  stat.innerHTML = `
    <div class="glass stat"><span>Caixa</span><b>${state.caixa.aberto ? 'Aberto' : 'Fechado'}</b></div>
    <div class="glass stat"><span>Troco inicial</span><b>${fmt(Number(state.caixa.trocoInicial ?? state.caixa.saldoInicial ?? 50))}</b></div>
    <div class="glass stat"><span>Estoque troco</span><b>${fmt(Number(state.caixa.estoqueTroco ?? 200))}</b></div>
    <div class="glass stat"><span>Entradas</span><b>${fmt(entradas)}</b></div>
    <div class="glass stat"><span>Saídas</span><b>${fmt(saidas)}</b></div>
    <div class="glass stat lucro-stat"><span>Saldo atual</span><b>${fmt(Number(state.caixa.saldoFinal || 0))}</b></div>
  `;
  if(state.caixa.movimentacoes.length === 0){
    lista.innerHTML = '<div class="empty-state">Nenhuma movimentação registrada no caixa.</div>';
    return;
  }
  lista.innerHTML = state.caixa.movimentacoes.map(m => `
    <div class="row-card">
      <div class="main-info">
        <b>${m.descricao}</b>
        <small>${new Date(m.data).toLocaleString('pt-BR')} · ${m.vendedor || 'Sistema'}</small>
      </div>
      <strong class="${Number(m.valor) >= 0 ? 'lucro-valor' : 'boleto-pago'}">${fmt(Number(m.valor || 0))}</strong>
    </div>
  `).join('');
}

function abrirCaixa(){
  const modal = document.getElementById('abrirCaixaModal');
  const valorInput = document.getElementById('caixaAberturaValor');
  const estoqueInput = document.getElementById('caixaAberturaEstoque');
  if(!modal || !valorInput || !estoqueInput) return;
  const valorPadrao = Number(state.caixa.trocoInicial ?? state.caixa.saldoInicial ?? VALOR_CAIXA_PADRAO);
  const estoquePadrao = Number(state.caixa.estoqueTroco ?? ESTOQUE_TROCO_PADRAO);
  valorInput.value = String(Number.isFinite(valorPadrao) && valorPadrao > 0 ? valorPadrao : VALOR_CAIXA_PADRAO);
  estoqueInput.value = String(Number.isFinite(estoquePadrao) && estoquePadrao >= 0 ? estoquePadrao : ESTOQUE_TROCO_PADRAO);
  modal.classList.add('show');
}

function confirmarAberturaCaixa(){
  const valor = Number(document.getElementById('caixaAberturaValor')?.value || 0);
  const estoque = Number(document.getElementById('caixaAberturaEstoque')?.value || 0);
  if(isNaN(valor) || valor < 0 || isNaN(estoque) || estoque < 0){
    toast('Informe valores válidos para abertura do caixa.');
    return;
  }
  document.getElementById('abrirCaixaModal').classList.remove('show');
  const valorFinal = valor || VALOR_CAIXA_PADRAO;
  const estoqueFinal = estoque || ESTOQUE_TROCO_PADRAO;
  state.caixa = normalizarCaixaPadrao({
    aberto: true,
    saldoInicial: valorFinal,
    saldoFinal: valorFinal,
    trocoInicial: valorFinal,
    estoqueTroco: estoqueFinal,
    movimentacoes: [{ id: uid(), tipo: 'abertura', descricao: 'Abertura de caixa', valor: valorFinal, data: new Date().toISOString(), vendedor: state.vendedorLogado?.nome || 'Sistema' }]
  });
  saveCaixa();
  renderCaixa();
  toast('Caixa aberto com sucesso.');
}

function fecharCaixa(){
  if(!state.caixa.aberto){ toast('O caixa já está fechado.'); return; }
  const modal = document.getElementById('confirmarFechamentoCaixaModal');
  if(modal){ modal.classList.add('show'); }
}

function renderResumoFechamentoCaixa(){
  const resumo = obterResumoFechamentoCaixa();
  const corpo = document.getElementById('fechamentoCaixaResumoCorpo');
  if(!corpo) return;
  corpo.innerHTML = `
    <div class="totais-row"><span>Troco em caixa</span><strong>${fmt(resumo.trocoCaixa)}</strong></div>
    <div class="totais-row"><span>Estoque para troco</span><strong>${fmt(resumo.estoqueTroco)}</strong></div>
    <div class="totais-row"><span>Dinheiro</span><strong>${fmt(resumo.Dinheiro)}</strong></div>
    <div class="totais-row"><span>Cartão</span><strong>${fmt(resumo.Cartão)}</strong></div>
    <div class="totais-row"><span>Pix</span><strong>${fmt(resumo.Pix)}</strong></div>
    <div class="totais-row"><span>PicPay</span><strong>${fmt(resumo.PicPay)}</strong></div>
    <div class="totais-row"><span>Fiado</span><strong>${fmt(resumo.Fiado)}</strong></div>
    <div class="totais-row total"><span>Total de entradas</span><strong>${fmt(resumo.totalEntradas)}</strong></div>
    <div class="totais-row total"><span>Saldo previsto</span><strong>${fmt(resumo.saldoFinalPrevisto)}</strong></div>
  `;
}

async function confirmarFechamentoCaixa(){
  renderResumoFechamentoCaixa();
  document.getElementById('confirmarFechamentoCaixaModal').classList.remove('show');
  document.getElementById('fechamentoResumoCaixaModal').classList.add('show');
}

async function finalizarFechamentoCaixa(){
  const resumo = obterResumoFechamentoCaixa();
  const saldoBase = Number(state.caixa.trocoInicial ?? state.caixa.saldoInicial ?? VALOR_CAIXA_PADRAO);
  state.caixa.aberto = false;
  state.caixa.saldoFinal = saldoBase + resumo.totalEntradas;
  state.caixa.movimentacoes.unshift({
    id: uid(),
    tipo: 'fechamento',
    descricao: 'Fechamento de caixa',
    valor: -Math.abs(Number(state.caixa.saldoFinal || 0)),
    data: new Date().toISOString(),
    vendedor: state.vendedorLogado?.nome || 'Sistema'
  });
  await saveCaixa();
  renderCaixa();
  document.getElementById('fechamentoResumoCaixaModal').classList.remove('show');
  toast('Caixa fechado com resumo registrado.');
}

document.getElementById('abrirCaixaBtn').addEventListener('click', abrirCaixa);
document.getElementById('fecharCaixaBtn').addEventListener('click', fecharCaixa);
document.getElementById('caixaAberturaConfirmar').addEventListener('click', confirmarAberturaCaixa);
document.getElementById('caixaAberturaCancelar').addEventListener('click', ()=> document.getElementById('abrirCaixaModal').classList.remove('show'));
document.getElementById('fechamentoCaixaCancelar').addEventListener('click', ()=> document.getElementById('confirmarFechamentoCaixaModal').classList.remove('show'));
document.getElementById('fechamentoCaixaConfirmar').addEventListener('click', confirmarFechamentoCaixa);
document.getElementById('fechamentoCaixaResumoFechar').addEventListener('click', ()=> document.getElementById('fechamentoResumoCaixaModal').classList.remove('show'));
document.getElementById('fechamentoCaixaResumoConfirmar').addEventListener('click', finalizarFechamentoCaixa);

function renderBoletos(){
  const lista = document.getElementById('listaBoletos');
  const stat = document.getElementById('boletoStatRow');
  if(!lista || !stat) return;
  const ativos = state.boletos.filter(b=>{
    const venda = state.vendas.find(v=>v.id===b.vendaId);
    return !venda || !venda.cancelada;
  }).filter(b=>!b.cancelado);
  const abertos = ativos.filter(b=>statusBoleto(b)==='aberto');
  const vencidos = ativos.filter(b=>statusBoleto(b)==='vencido');
  const pagos = ativos.filter(b=>statusBoleto(b)==='pago');
  stat.innerHTML = `
    <div class="glass stat"><span>Em aberto</span><b>${fmt(abertos.reduce((s,b)=>s+b.valor,0))}</b></div>
    <div class="glass stat"><span>Vencidos</span><b>${fmt(vencidos.reduce((s,b)=>s+b.valor,0))}</b></div>
    <div class="glass stat"><span>Pagos</span><b>${fmt(pagos.reduce((s,b)=>s+b.valor,0))}</b></div>
  `;
  const filtroStatus = document.getElementById('boletoFiltroStatus').value;
  const dataInicial = document.getElementById('boletoFiltroInicial').value;
  const dataFinal = document.getElementById('boletoFiltroFinal').value;
  const clienteBusca = normalizar(document.getElementById('boletoFiltroCliente').value);
  const filtrados = ativos.filter(b=>{
    const status = statusBoleto(b);
    return (filtroStatus==='todos' || status===filtroStatus)
      && (!dataInicial || b.vencimento >= dataInicial)
      && (!dataFinal || b.vencimento <= dataFinal)
      && (!clienteBusca || normalizar(b.tipo==='pagar' ? b.fornecedor : b.clienteNome).includes(clienteBusca));
  }).sort((a,b)=>a.vencimento.localeCompare(b.vencimento));
  if(filtrados.length===0){
    lista.innerHTML = `<div class="empty-state">Nenhum boleto encontrado para os filtros selecionados.</div>`;
    return;
  }
  lista.innerHTML = filtrados.map(b=>{
    const status = statusBoleto(b);
    const rotulo = status==='pago' ? 'Pago' : status==='vencido' ? 'Vencido' : 'Em aberto';
    const classe = status==='pago' ? 'ok' : 'low';
    return `<div class="row-card boleto-card" data-id="${b.id}">
      <div class="main-info">
        <b>${b.tipo==='pagar' ? b.fornecedor : b.clienteNome}</b>
        <small>${b.tipo==='pagar' ? `A pagar · Nota fiscal ${b.codigoNota}` : `A receber · Venda #${b.codigoVenda}`} · Vencimento: ${formatarDataBoleto(b.vencimento)}</small>
      </div>
      <span class="badge ${classe}">${rotulo}</span>
      <strong>${fmt(b.valor)}</strong>
      ${status!=='pago' ? '<button class="btn-primary boleto-baixar" data-act="baixar" style="padding:8px 12px; font-size:11px;">Marcar pago</button>' : '<span class="boleto-pago">Recebido</span>'}
    </div>`;
  }).join('');
}
['boletoFiltroStatus','boletoFiltroInicial','boletoFiltroFinal','boletoFiltroCliente'].forEach(id=>{
  document.getElementById(id).addEventListener('input', renderBoletos);
  document.getElementById(id).addEventListener('change', renderBoletos);
});
document.getElementById('listaBoletos').addEventListener('click', async e=>{
  const botao = e.target.closest('[data-act="baixar"]');
  if(!botao) return;
  const card = botao.closest('.boleto-card');
  const boleto = state.boletos.find(b=>b.id===card.dataset.id);
  if(!boleto) return;
  boleto.pago = true;
  boleto.pagoEm = new Date().toISOString();
  await saveBoletos();
  renderBoletos();
  toast('Boleto marcado como pago.');
});

/* ---------------- PWA / Instalável ---------------- */
function registrarServiceWorker(){
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Service worker não registrado:', error);
    });
  });
}

function iniciarSincronizacaoEmTempoReal(){
  if (!('EventSource' in window)) return;
  const eventos = new EventSource('/api/pdv/events');
  eventos.addEventListener('storage', () => sincronizarComServidor());
}

/* ---------------- Init ---------------- */
async function init(){
  await initTheme();
  await initFundo();
  await initEfeito3D();
  await loadAll();
  await saveSnapshotPDV();
  renderProdutos(); renderCart();
  renderEstoque(); renderClientes(); renderVendedores();
  renderConfigPagamentos();
  renderVendasRecentes();
  renderBoletos();
  renderNotasImportadas();
  renderCaixa();
  setupVisualMotion();
  aplicarAtalhosTeclado();
  registrarServiceWorker();
  iniciarSincronizacaoEmTempoReal();
  document.getElementById('loginUser').focus();

  window.addEventListener('beforeunload', () => {
    saveSnapshotPDV();
  });

  setInterval(() => {
    if (state.loaded) {
      saveSnapshotPDV();
    }
  }, 15000);

  setInterval(() => {
    if (state.loaded && document.getElementById('loginScreen').style.display === 'none') {
      sincronizarComServidor();
    }
  }, 5000);
}
init();

['descontoInput','valorRecebidoInput'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', renderCart);
});
