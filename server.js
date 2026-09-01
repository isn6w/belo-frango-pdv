const express = require('express');
const path = require('path');
const session = require('express-session');
const { db, initialize } = require('./db');
const bcrypt = require('bcrypt');
const { EventEmitter } = require('events');

const app = express();
const PORT = process.env.PORT || 3000;
const isServerlessRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);
const storageEvents = new EventEmitter();

if (isServerlessRuntime) {
  app.set('trust proxy', 1);
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuração de sessão
app.use(session({
  secret: process.env.SESSION_SECRET || 'belo-frango-super-mercearia-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isServerlessRuntime ? true : false,
    httpOnly: true,
    sameSite: isServerlessRuntime ? 'none' : 'lax',
    maxAge: 3600000
  }
}));

// Rotas da API

// Login de usuário
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  db.get('SELECT * FROM usuarios WHERE username = ?', [username], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao conectar ao banco' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }

    if (user.ativo !== 1) {
      return res.status(403).json({ error: 'Usuário desativado' });
    }

    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao autenticar' });
      }

      if (!isMatch) {
        return res.status(401).json({ error: 'Senha incorreta' });
      }

      // Cria sessão
      req.session.usuario = {
        id: user.id,
        username: user.username,
        nome: user.nome,
        cargo: user.cargo
      };

      res.json({ success: true, usuario: req.session.usuario });
    });
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Verifica se usuário está logado
app.get('/api/usuario/logado', (req, res) => {
  if (req.session.usuario) {
    res.json({ logado: true, usuario: req.session.usuario });
  } else {
    res.json({ logado: false });
  }
});

// Rotas de Clientes
app.get('/api/clientes', (req, res) => {
  const { search, ativo = 1 } = req.query;
  let sql = 'SELECT * FROM clientes WHERE ativo = ?';
  const params = [ativo];

  if (search) {
    sql += ' AND (nome LIKE ? OR codigo LIKE ? OR cpf_cnpj LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY nome';

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar clientes' });
    }
    res.json(rows);
  });
});

app.get('/api/clientes/:id', (req, res) => {
  db.get('SELECT * FROM clientes WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar cliente' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }
    res.json(row);
  });
});

app.post('/api/clientes', (req, res) => {
  const { codigo, nome, cpf_cnpj, telefone, email, endereco } = req.body;

  db.run(
    `INSERT INTO clientes (codigo, nome, cpf_cnpj, telefone, email, endereco, pontos, fiado)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
    [codigo, nome, cpf_cnpj || '', telefone || '', email || '', endereco || ''],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, success: true });
    }
  );
});

app.put('/api/clientes/:id', (req, res) => {
  const { nome, cpf_cnpj, telefone, email, endereco, ativo } = req.body;

  db.run(
    `UPDATE clientes SET nome = ?, cpf_cnpj = ?, telefone = ?, email = ?,
     endereco = ?, ativo = ?, atualizado_em = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nome, cpf_cnpj, telefone, email, endereco, ativo, req.params.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Rotas de Produtos
app.get('/api/produtos', (req, res) => {
  const { search, ativo = 1, categoria } = req.query;
  let sql = 'SELECT * FROM produtos WHERE ativo = ?';
  const params = [ativo];

  if (categoria) {
    sql += ' AND categoria = ?';
    params.push(categoria);
  }

  if (search) {
    sql += ' AND (nome LIKE ? OR codigo LIKE ? OR categoria LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY categoria, nome';

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar produtos' });
    }
    res.json(rows);
  });
});

app.get('/api/produtos/:id', (req, res) => {
  db.get('SELECT * FROM produtos WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar produto' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    res.json(row);
  });
});

app.post('/api/produtos', (req, res) => {
  const { codigo, nome, descricao, categoria, preco_venda, preco_custo, quantidade_estoque, unidade, estoque_minimo } = req.body;

  db.run(
    `INSERT INTO produtos (codigo, nome, descricao, categoria, preco_venda, preco_custo,
     quantidade_estoque, unidade, estoque_minimo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [codigo, nome, descricao || '', categoria || 'Outros', preco_venda, preco_custo || 0,
     quantidade_estoque || 0, unidade || 'kg', estoque_minimo || 5],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, success: true });
    }
  );
});

app.put('/api/produtos/:id', (req, res) => {
  const { nome, descricao, categoria, preco_venda, preco_custo, quantidade_estoque, unidade, estoque_minimo, ativo } = req.body;

  db.run(
    `UPDATE produtos SET nome = ?, descricao = ?, categoria = ?, preco_venda = ?,
     preco_custo = ?, quantidade_estoque = ?, unidade = ?, estoque_minimo = ?,
     ativo = ?, atualizado_em = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nome, descricao, categoria, preco_venda, preco_custo, quantidade_estoque, unidade,
     estoque_minimo, ativo, req.params.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Atualizar estoque após venda
app.post('/api/produtos/atualizar-estoque', (req, res) => {
  const { items } = req.body; // Array de {id_produto, quantidade}

  const updatePromises = items.map(item => {
    return new Promise((resolve, reject) => {
      db.get('SELECT quantidade_estoque FROM produtos WHERE id = ?', [item.id_produto], (err, produto) => {
        if (err) return reject(err);

        const novaQuantidade = produto.quantidade_estoque - item.quantidade;

        db.run(
          'UPDATE produtos SET quantidade_estoque = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?',
          [novaQuantidade, item.id_produto],
          function(err) {
            if (err) return reject(err);
            resolve({ id: item.id_produto, novaQuantidade });
          }
        );
      });
    });
  });

  Promise.all(updatePromises)
    .then(resultados => res.json({ success: true, resultados }))
    .catch(err => res.status(500).json({ error: err.message }));
});

// Rotas de Vendas
app.get('/api/vendas', (req, res) => {
  const { data_inicial, data_final, cliente, vendedor } = req.query;
  let sql = `
    SELECT v.*,
           u.nome as vendedor_nome,
           c.nome as cliente_nome,
           c.codigo as cliente_codigo
    FROM vendas v
    LEFT JOIN usuarios u ON v.id_vendedor = u.id
    LEFT JOIN clientes c ON v.id_cliente = c.id
    WHERE 1=1
  `;
  const params = [];

  if (data_inicial) {
    sql += ' AND v.criado_em >= ?';
    params.push(data_inicial);
  }
  if (data_final) {
    sql += ' AND v.criado_em <= ?';
    params.push(data_final);
  }
  if (cliente) {
    sql += ' AND (c.nome LIKE ? OR c.codigo LIKE ?)';
    params.push(`%${cliente}%`, `%${cliente}%`);
  }
  if (vendedor) {
    sql += ' AND u.nome LIKE ?';
    params.push(`%${vendedor}%`);
  }

  sql += ' ORDER BY v.criado_em DESC';

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar vendas' });
    }

    // Buscar itens de cada venda
    Promise.all(rows.map(venda => {
      return new Promise((resolve, reject) => {
        db.all('SELECT * FROM itens_venda WHERE id_venda = ?', [venda.id], (err, itens) => {
          if (err) return reject(err);
          venda.itens = itens;
          resolve(venda);
        });
      });
    })).then(vendasComItens => res.json(vendasComItens));
  });
});

app.get('/api/vendas/:id', (req, res) => {
  db.get('SELECT * FROM vendas WHERE id = ?', [req.params.id], (err, venda) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar venda' });
    }
    if (!venda) {
      return res.status(404).json({ error: 'Venda não encontrada' });
    }

    db.all('SELECT * FROM itens_venda WHERE id_venda = ?', [venda.id], (err, itens) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao buscar itens' });
      }
      venda.itens = itens;
      res.json(venda);
    });
  });
});

app.post('/api/vendas', (req, res) => {
  const { id_vendedor, id_cliente, forma_pagamento, tipo_pagamento, itens, valor_total, valor_pago } = req.body;

  const data_hora = new Date();
  const codigo_venda = `V${data_hora.getFullYear()}${String(data_hora.getMonth() + 1).padStart(2, '0')}${String(data_hora.getDate()).padStart(2, '0')}${String(data_hora.getHours()).padStart(2, '0')}${String(data_hora.getMinutes()).padStart(2, '0')}${String(data_hora.getSeconds()).padStart(2, '0')}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

  const valor_troco = parseFloat((valor_pago - valor_total).toFixed(2));

  db.run(
    `INSERT INTO vendas (codigo_venda, id_vendedor, id_cliente, forma_pagamento, tipo_pagamento,
     valor_total, valor_pago, valor_troco, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finalizada')`,
    [codigo_venda, id_vendedor, id_cliente || null, forma_pagamento, tipo_pagamento || '', valor_total, valor_pago],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const id_venda = this.lastID;

      // Inserir itens da venda
      const insertItem = db.prepare(
        'INSERT INTO itens_venda (id_venda, id_produto, nome_produto, codigo_produto, quantidade, preco_unitario, total_item) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      itens.forEach(item => {
        insertItem.run(id_venda, item.id_produto, item.nome_produto, item.codigo_produto, item.quantidade, item.preco_unitario, item.total_item);
      });

      insertItem.finalize();

      // Atualizar estoque
      const atualizarEstoque = db.prepare(
        'UPDATE produtos SET quantidade_estoque = quantidade_estoque - ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?'
      );

      itens.forEach(item => {
        atualizarEstoque.run(item.quantidade, item.id_produto);
      });

      atualizarEstoque.finalize();

      // Atualizar histórico de compras do cliente
      if (id_cliente) {
        db.run(
          `UPDATE clientes SET
           valor_total_compras = valor_total_compras + ?,
           pontos = pontos + CAST(? AS INTEGER),
           fiado = fiado + CASE WHEN ? = 'fiado' THEN ? ELSE 0 END,
           atualizado_em = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [valor_total, valor_total, forma_pagamento, forma_pagamento === 'fiado' ? valor_total : 0, id_cliente]
        );
      }

      res.json({ success: true, id: id_venda, codigo_venda });
    }
  );
});

app.post('/api/vendas/:id/cancelar', (req, res) => {
  db.get('SELECT * FROM vendas WHERE id = ?', [req.params.id], (err, venda) => {
    if (err || !venda) {
      return res.status(404).json({ error: 'Venda não encontrada' });
    }

    if (venda.status === 'cancelada') {
      return res.status(400).json({ error: 'Venda já está cancelada' });
    }

    // Restaurar estoque
    db.all('SELECT * FROM itens_venda WHERE id_venda = ?', [venda.id], (err, itens) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao restaurar estoque' });
      }

      itens.forEach(item => {
        db.run(
          'UPDATE produtos SET quantidade_estoque = quantidade_estoque + ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?',
          [item.quantidade, item.id_produto]
        );
      });

      db.run('UPDATE vendas SET status = ? WHERE id = ?', ['cancelada', req.params.id], function(err) {
        if (err) {
          return res.status(500).json({ error: 'Erro ao cancelar venda' });
        }
        res.json({ success: true, message: 'Venda cancelada com sucesso' });
      });
    });
  });
});

// Configurações
app.get('/api/configuracoes', (req, res) => {
  db.all('SELECT * FROM configuracoes', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar configurações' });
    }

    const configs = {};
    rows.forEach(row => {
      configs[row.chave] = row.valor;
    });
    res.json(configs);
  });
});

app.put('/api/configuracoes/:chave', (req, res) => {
  const { chave } = req.params;
  const { valor, descricao } = req.body;

  db.run(
    'UPDATE configuracoes SET valor = ?, descricao = ? WHERE chave = ?',
    [valor, descricao, chave],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, valor });
    }
  );
});

// Persistência da interface do PDV. Os valores ficam no SQLite, não no navegador.
app.get('/api/storage/:chave', (req, res) => {
  db.get('SELECT valor FROM app_storage WHERE chave = ?', [req.params.chave], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao carregar dados' });
    res.json({ value: row ? row.valor : null });
  });
});

app.get('/api/pdv/events', (req, res) => {
  res.set({
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream'
  });
  res.flushHeaders();
  res.write(': conectado\n\n');

  const enviarEvento = chave => {
    res.write(`event: storage\ndata: ${JSON.stringify({ chave })}\n\n`);
  };
  storageEvents.on('storage', enviarEvento);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    storageEvents.off('storage', enviarEvento);
  });
});

app.get('/api/pdv/snapshot', (req, res) => {
  db.get('SELECT valor FROM app_storage WHERE chave = ?', ['pdv_snapshot'], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao carregar snapshot do PDV' });
    if (!row || !row.valor) return res.json({ value: null });
    try {
      res.json({ value: JSON.parse(row.valor) });
    } catch (e) {
      res.status(500).json({ error: 'Snapshot inválido' });
    }
  });
});

app.put('/api/storage/:chave', (req, res) => {
  if (typeof req.body.valor !== 'string') return res.status(400).json({ error: 'Valor inválido' });
  const salvar = valor => db.run(
    `INSERT INTO app_storage (chave, valor, atualizado_em) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = CURRENT_TIMESTAMP`,
    [req.params.chave, valor],
    err => {
      if (err) return res.status(500).json({ error: 'Erro ao salvar dados' });
      storageEvents.emit('storage', req.params.chave);
      res.json({ success: true });
    }
  );

  if (req.params.chave !== 'vendas') return salvar(req.body.valor);

  let vendasRecebidas;
  try {
    vendasRecebidas = JSON.parse(req.body.valor);
    if (!Array.isArray(vendasRecebidas)) return salvar(req.body.valor);
  } catch (err) {
    return res.status(400).json({ error: 'Valor inválido' });
  }

  db.get('SELECT valor FROM app_storage WHERE chave = ?', ['vendas'], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao carregar dados atuais' });
    let vendasAtuais = [];
    try {
      const valorAtual = row && JSON.parse(row.valor);
      if (Array.isArray(valorAtual)) vendasAtuais = valorAtual;
    } catch (erro) {}

    const porId = new Map(vendasAtuais.map(venda => [String(venda.id), venda]));
    vendasRecebidas.forEach(venda => porId.set(String(venda.id), venda));
    salvar(JSON.stringify([...porId.values()]));
  });
});

app.put('/api/pdv/snapshot', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Payload inválido' });
  const valor = JSON.stringify(req.body);
  db.run(
    `INSERT INTO app_storage (chave, valor, atualizado_em) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = CURRENT_TIMESTAMP`,
    ['pdv_snapshot', valor],
    err => {
      if (err) return res.status(500).json({ error: 'Erro ao salvar snapshot do PDV' });
      res.json({ success: true });
    }
  );
});
// Rota principal - serve a interface
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  initialize();
}

ensureInitialized();

if (isServerlessRuntime) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  Belo Frango PDV - Sistema de Vendas`);
    console.log(`========================================`);
    console.log(`  Servidor rodando em: http://localhost:${PORT}`);
    console.log(`  Acesse para começar a usar o sistema\n`);
  });
}

module.exports = app;
