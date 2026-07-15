// api/refresh-trades.js

export const config = { maxDuration: 30 };

const TRADES_KV_KEY = 'trades-cache.json';
const CSWAP_KV_KEY = 'cswap-cache.json';
const MAX_TRADES = 60;
const DELAY_MS = 2500; 

const TOKENS = [
  { id: 'strike', symbol: 'STRIKE', policy_id: 'f13ac4d66b3ee19a6aa0f2a22298737bd907cc95121662fc971b5275', asset_name: '535452494b45' },
  { id: 'ascend', symbol: 'ASCEND', policy_id: 'eb7a93ebc321647673490810f618b548d7c24aa64d30ae342dba7076', asset_name: '0014df10415343454e44' },
  { id: 'surf', symbol: 'SURF', policy_id: '2d9db8a89f074aa045eab177f23a3395f62ced8b53499a9e4ad46c80', asset_name: '464c4f57' },
  { id: 'pulse', symbol: 'PULSE', policy_id: '2da97f55d49be13dabc8450a2eabab0412f3075a03f7519d32d46925', asset_name: '0014df1050554c5345' },
  { id: 'atlas', symbol: 'ATLAS', policy_id: '9ff9a1b456f074e03be90631e1a5f9b6ed08eacabd0e7f95a11ffff1', asset_name: '0014df1041544c4153' },
];

const POOL_ADDRESSES = {
  strike: ["f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c73e1518e92f367fd5820ac2da1d40ab24fbca1d6cb2c28121ad92f57aff8abce"],
  ascend: ["f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ce66195788208dcd363edb600eaf2331019e3599baba645d81d61ef060c82d861"],
  surf: ["f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4cb623827076d8b01e7529a77d9f0a9c2fb863dc9aa36416a4ebb12f9d0a6e7f15"],
  pulse: ["f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c0c931d4690bc1c779e1ad3fbe20ebcf8888bee0a5b26b7a5042d106da6d974f1"],
  atlas: ["f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c71a87b654d5b109bd1e860ee1b0bedcf15a91b558db895d788720bb86462b100"],
};

const GT_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const CSWAP_CONTRACT = 'addr1z8ke0c9p89rjfwmuh98jpt8ky74uy5mffjft3zlcld9h7ml3lmln3mwk0y3zsh3gs3dzqlwa9rjzrxawkwm4udw9axhs6fuu6e';
const STRIKE_POLICY = 'f13ac4d66b3ee19a6aa0f2a22298737bd907cc95121662fc971b5275';
const STRIKE_ASSET = '535452494b45';
const STRIKE_UNIT = STRIKE_POLICY + STRIKE_ASSET;
const STRIKE_DECIMALS = 6;
const BLOCKFROST_LIMIT = 20;
const CSWAP_CACHE_TTL_MS = 30 * 60 * 1000;

const WHALECOIN_POLICY = '326c008488f7b9a8c6fbe9e4ab2c8d1ba8d7f33284970f3dd2d5142d';
const WHALECOIN_ASSET_HEX = '5748414c45434f494e';
const WHALECOIN_UNIT = WHALECOIN_POLICY + WHALECOIN_ASSET_HEX; 
const SNEKFUN_ASSET_ID = `${WHALECOIN_POLICY}.${WHALECOIN_ASSET_HEX}`;
const WHALECOIN_KV_KEY = 'whalecoin-cache.json';
const WHALECOIN_CACHE_TTL_MS = 15 * 60 * 1000; 
const WHALECOIN_LIMIT = 60;
const WHALECOIN_MAX_AGE_MS = 12 * 60 * 60 * 1000; 

// ============================================================
// Cloudflare KV vía API REST
// ============================================================
function cfKvUrl(key) {
  const { CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID } = process.env;
  return `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
}

async function kvGet(key) {
  try {
    const res = await fetch(cfKvUrl(key), {
      headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function kvPut(key, value) {
  const res = await fetch(cfKvUrl(key), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudflare KV PUT ${res.status}: ${text}`);
  }
  return res.json();
}

// ============================================================
// GeckoTerminal
// ============================================================
function normalizeTrade(raw, token) {
  const a = raw?.attributes || {};
  const kind = (a.kind || a.type || a.trade_type || '').toLowerCase();
  const side = kind.includes('sell') ? 'sell' : kind.includes('buy') ? 'buy' : null;
  if (!side) return null;

  let tokenAmount, pricePerToken;
  if (side === 'buy') {
    tokenAmount = Number(a.to_token_amount ?? a.amount ?? NaN);
    pricePerToken = Number(a.price_to_in_currency_token ?? a.price_in_ada ?? NaN);
  } else {
    tokenAmount = Number(a.from_token_amount ?? a.amount ?? NaN);
    pricePerToken = Number(a.price_from_in_currency_token ?? a.price_in_ada ?? NaN);
  }
  if (!isFinite(tokenAmount) || tokenAmount <= 0) return null;
  if (!isFinite(pricePerToken) || pricePerToken <= 0) return null;

  const timestamp = a.block_timestamp || a.timestamp || a.tx_timestamp || null;
  const txHash = a.tx_hash || a.transaction_hash || a.hash || null;
  const wallet = a.tx_from_address || a.from_address || a.maker || null;

  if (!timestamp) return null;

  return {
    symbol: token.symbol,
    side,
    tokenAmount,
    priceAda: pricePerToken,
    txHash,
    wallet,
    timestamp: new Date(timestamp).getTime(),
  };
}

async function fetchTradesForPool(token, poolAddress) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/cardano/pools/${poolAddress}/trades`;
    const res = await fetch(url, { headers: GT_HEADERS, signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.status === 429) {
      console.warn(`⚠️ 429 para ${token.symbol}. Se conserva el caché anterior de este token.`);
      return null;
    }
    if (!res.ok) {
      console.warn(`⚠️ Error ${res.status} para ${token.symbol}. Se conserva el caché anterior de este token.`);
      return null;
    }
    const data = await res.json();
    return (data?.data || []).map(r => normalizeTrade(r, token)).filter(Boolean);
  } catch (e) {
    clearTimeout(timeoutId);
    console.warn(`❌ fallo en ${token.symbol}:`, e.message, '- Se conserva el caché anterior de este token.');
    return null;
  }
}

function removeDuplicateTrades(trades) {
  const seen = new Set();
  const unique = [];
  for (const t of trades) {
    const key = t.txHash || `${t.symbol}-${t.side}-${t.timestamp}-${t.tokenAmount}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(t);
    }
  }
  return unique;
}

// ============================================================
// CSWAP (Blockfrost)
// ============================================================
async function blockfrostRequest(endpoint) {
  const url = `https://cardano-mainnet.blockfrost.io/api/v0${endpoint}`;
  const res = await fetch(url, {
    headers: {
      project_id: process.env.BLOCKFROST_PROJECT_ID || '',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blockfrost ${res.status}: ${text}`);
  }
  return res.json();
}

function sumUnitAmount(amountArr, unit) {
  return (amountArr || [])
    .filter(a => a.unit === unit)
    .reduce((sum, a) => sum + Number(a.quantity), 0);
}

function detectPoolSwap(tx, contractAddress) {
  const poolIns = (tx.inputs || []).filter(x => x.address === contractAddress);
  const poolOuts = (tx.outputs || []).filter(x => x.address === contractAddress);

  if (poolIns.length !== 1 || poolOuts.length !== 1) {
    return { isSwap: false };
  }

  const lovelaceIn = sumUnitAmount(poolIns[0].amount, 'lovelace');
  const lovelaceOut = sumUnitAmount(poolOuts[0].amount, 'lovelace');
  const strikeIn = sumUnitAmount(poolIns[0].amount, STRIKE_UNIT);
  const strikeOut = sumUnitAmount(poolOuts[0].amount, STRIKE_UNIT);

  const deltaLovelace = lovelaceOut - lovelaceIn;
  const deltaStrike = strikeOut - strikeIn;

  if (deltaLovelace === 0 || deltaStrike === 0) {
    return { isSwap: false };
  }

  const tokenAmount = Math.abs(deltaStrike) / Math.pow(10, STRIKE_DECIMALS);
  const adaAmount = Math.abs(deltaLovelace) / 1_000_000;

  if (!isFinite(tokenAmount) || tokenAmount <= 0 || !isFinite(adaAmount) || adaAmount <= 0) {
    return { isSwap: false };
  }

  const side = deltaLovelace > 0 ? 'buy' : 'sell';
  const userInput = (tx.inputs || []).find(x => x.address !== contractAddress);

  return {
    isSwap: true,
    side,
    tokenAmount,
    adaAmount,
    priceAda: adaAmount / tokenAmount,
    wallet: userInput?.address || null,
  };
}

async function getCswapTrades() {
  const cached = await kvGet(CSWAP_KV_KEY);
  if (cached && Date.now() - cached.timestamp < CSWAP_CACHE_TTL_MS) {
    console.log('📦 Usando caché de CSWAP');
    return cached.trades || [];
  }

  try {
    const txs = await blockfrostRequest(
      `/addresses/${CSWAP_CONTRACT}/transactions?order=desc&count=${BLOCKFROST_LIMIT}`
    );

    const BATCH_SIZE = 5;
    const utxosResults = [];
    for (let i = 0; i < txs.length; i += BATCH_SIZE) {
      const batch = txs.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(tx => blockfrostRequest(`/txs/${tx.tx_hash}/utxos`).catch(err => {
          console.warn(`⚠️ Error en ${tx.tx_hash}: ${err.message}`);
          return null;
        }))
      );
      utxosResults.push(...batchResults);
      if (i + BATCH_SIZE < txs.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    const trades = [];
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      const utxos = utxosResults[i];
      if (!utxos) continue;
      const detection = detectPoolSwap({
        tx_hash: tx.tx_hash,
        inputs: utxos.inputs || [],
        outputs: utxos.outputs || [],
      }, CSWAP_CONTRACT);
      if (detection.isSwap) {
        trades.push({
          symbol: 'STRIKE',
          side: detection.side,
          tokenAmount: detection.tokenAmount,
          priceAda: detection.priceAda,
          txHash: tx.tx_hash,
          wallet: detection.wallet,
          timestamp: tx.block_time * 1000,
        });
      }
    }

    await kvPut(CSWAP_KV_KEY, { trades, timestamp: Date.now() });
    return trades;
  } catch (error) {
    console.error('❌ Error obteniendo CSWAP trades:', error.message);
    if (cached && cached.trades) {
      console.log('📦 Usando caché antiguo de CSWAP (por error)');
      return cached.trades;
    }
    return [];
  }
}

// ============================================================
// WHALECOIN (bonding curve en snek.fun, via analytics.snek.fun)
// ============================================================
function parseSnekfunOrder(item) {

  const isBuy = item.from === '.';
  const isSell = item.to === '.';
  if (!isBuy && !isSell) return null; 

  const adaRaw = isBuy ? item.fromAmount : item.toAmount;
  const whaleRaw = isBuy ? item.toAmount : item.fromAmount;

  const adaAmount = Number(adaRaw) / 1_000_000;
  const tokenAmount = Number(whaleRaw); 

  if (!isFinite(adaAmount) || adaAmount <= 0 || !isFinite(tokenAmount) || tokenAmount <= 0) {
    return null;
  }

  const txHash = item.evaluatedTransactionId || item.pendingTransactionId || null;
  if (!txHash || !item.timestamp) return null;

  return {
    symbol: 'WHALE',
    side: isBuy ? 'buy' : 'sell',
    tokenAmount,
    priceAda: adaAmount / tokenAmount,
    txHash,
    wallet: item.address || null,
    timestamp: item.timestamp * 1000,
  };
}

async function getWhalecoinTrades() {
  const cached = await kvGet(WHALECOIN_KV_KEY);
  if (cached && Date.now() - cached.timestamp < WHALECOIN_CACHE_TTL_MS) {
    console.log('📦 Usando caché de WHALECOIN');
    const cutoff = Date.now() - WHALECOIN_MAX_AGE_MS;
    return (cached.trades || []).filter(t => t.timestamp >= cutoff);
  }

  try {
    const url = `https://analytics.snek.fun/v1/orders-feed/initial/state?asset=${encodeURIComponent(SNEKFUN_ASSET_ID)}&limit=${WHALECOIN_LIMIT}&offset=0`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '[]',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`snek.fun ${res.status}: ${text}`);
    }

    const data = await res.json();
    const items = data?.ledger?.items || [];

    const cutoff = Date.now() - WHALECOIN_MAX_AGE_MS;
    const trades = items
      .filter(it => it.status === 'Evaluated') // solo ordenes confirmadas, no pendientes/canceladas
      .map(parseSnekfunOrder)
      .filter(Boolean)
      .filter(t => t.timestamp >= cutoff); // no mostrar trades de mas de 12hs

    await kvPut(WHALECOIN_KV_KEY, { trades, timestamp: Date.now() });
    return trades;
  } catch (error) {
    console.error('❌ Error obteniendo trades de WHALECOIN (snek.fun):', error.message);
    if (cached && cached.trades) {
      console.log('📦 Usando caché antiguo de WHALECOIN (por error)');
      return cached.trades;
    }
    return [];
  }
}

// ============================================================
// Handler principal
// ============================================================
export default async function handler(req, res) {
  const providedSecret = req.query?.secret || req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  console.log('📡 Iniciando refresh de trades (Vercel)...');

  const previous = (await kvGet(TRADES_KV_KEY)) || { trades: [] };
  console.log('📦 Caché anterior tiene', previous.trades?.length || 0, 'trades');

  const previousBySymbol = {};
  for (const t of previous.trades || []) {
    (previousBySymbol[t.symbol] ||= []).push(t);
  }

  const resultsBySymbol = { ...previousBySymbol };
  const failedSymbols = [];
  const refreshedSymbols = [];

  const tokensWithPools = TOKENS.filter(t => POOL_ADDRESSES[t.id]?.length > 0);

  for (let i = 0; i < tokensWithPools.length; i++) {
    const token = tokensWithPools[i];
    const poolAddresses = POOL_ADDRESSES[token.id];
    console.log(`🔍 Procesando GeckoTerminal para ${token.symbol} (${poolAddresses.length} pools)...`);

    let allTradesForToken = [];
    for (let j = 0; j < poolAddresses.length; j++) {
      const trades = await fetchTradesForPool(token, poolAddresses[j]);
      if (trades && trades.length > 0) allTradesForToken.push(...trades);
      if (j < poolAddresses.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
    }

    const uniqueGeckoTrades = removeDuplicateTrades(allTradesForToken);

    if (i < tokensWithPools.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    if (token.id === 'strike') {
      console.log(`🔀 Fusionando GeckoTerminal (${uniqueGeckoTrades.length}) con CSWAP para STRIKE...`);
      const cswapTrades = await getCswapTrades();
      const combined = [...uniqueGeckoTrades, ...cswapTrades];
      const finalTrades = removeDuplicateTrades(combined);
      if (finalTrades.length > 0) {
        resultsBySymbol['STRIKE'] = finalTrades;
        refreshedSymbols.push('STRIKE');
      } else {
        failedSymbols.push('STRIKE');
      }
    } else {
      if (uniqueGeckoTrades.length > 0) {
        resultsBySymbol[token.symbol] = uniqueGeckoTrades;
        refreshedSymbols.push(token.symbol);
      } else {
        failedSymbols.push(token.symbol);
      }
    }
  }

  let allTrades = Object.values(resultsBySymbol).flat();

  console.log('🐋 Procesando WHALECOIN (snek.fun)...');
  const whaleTrades = await getWhalecoinTrades();
  if (whaleTrades.length > 0) {
    allTrades.push(...whaleTrades);
    refreshedSymbols.push('WHALE');
  } else {
    failedSymbols.push('WHALE');
  }

  allTrades = removeDuplicateTrades(allTrades);

  allTrades.sort((a, b) => b.timestamp - a.timestamp);
  const trades = allTrades.slice(0, MAX_TRADES);

  const result = { trades, updatedAt: Date.now() };
  if (failedSymbols.length > 0) result._staleSymbols = failedSymbols;

  try {
    await kvPut(TRADES_KV_KEY, result);
  } catch (e) {
    console.error('❌ Error CRÍTICO guardando en Cloudflare KV:', e.message);
    return res.status(500).json({ status: 'error', error: e.message });
  }

  const message = failedSymbols.length > 0
    ? `${refreshedSymbols.join(', ') || 'ninguno'} actualizado, ${failedSymbols.join(', ')} usó caché anterior.`
    : 'Todos los tokens actualizados correctamente.';

  console.log(`✅ Refresh completado. Total trades: ${allTrades.length}. Refrescados: ${refreshedSymbols.join(', ') || 'ninguno'}. Fallidos: ${failedSymbols.join(', ') || 'ninguno'}`);

  return res.status(200).json({
    status: 'ok',
    totalTrades: allTrades.length,
    batch: [...tokensWithPools.map(t => t.symbol), 'WHALE'],
    refreshedSymbols,
    failedSymbols,
    message,
  });
}
