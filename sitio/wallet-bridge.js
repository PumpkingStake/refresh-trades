
(function (global) {
  'use strict';

  var STORAGE_KEY = 'whalecoin.wallet';
  var EVENT_NAME = 'walletbridge:change';
  var RPC_TAG = '__whalecoin_walletbridge__';


  var isTopFrame;
  try { isTopFrame = (global.self === global.top); } catch (e) { isTopFrame = false; }

  var MAX_SESSION_AGE_MS = 12 * 60 * 60 * 1000; 

  var WALLETS = Object.freeze([
    {
      key: 'eternl', name: 'Eternl', color: '#9b7bf0', installUrl: 'https://eternl.io/', recommended: true,
      iconUrl: 'assets/eternl.png',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c1 0 1.83-.42 2.42-1.13L12 12l2.58 1.87A3 3 0 1017 9c-1 0-1.83.42-2.42 1.13L12 12 9.42 10.13A3 3 0 007 9z"/></svg>'
    },
    {
      key: 'lace', name: 'Lace', color: '#eef2f4', installUrl: 'https://www.lace.io/',
      iconUrl: 'assets/lace.png',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="7.3" y="7.3" width="9.4" height="9.4" rx="1.5" transform="rotate(45 12 12)"/></svg>'
    },
    {
      key: 'vespr', name: 'Vespr', color: '#eab308', installUrl: 'https://vespr.xyz/',
      iconUrl: 'assets/vespr.svg',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polygon points="12,3.5 19.5,7.75 19.5,16.25 12,20.5 4.5,16.25 4.5,7.75"/><text x="12" y="15.5" font-size="8" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none" font-family="Inter,sans-serif">V</text></svg>'
    }
  ]);
  var WALLET_KEYS = WALLETS.map(function (w) { return w.key; });

  function isPlausibleAddress(addr) {
    return typeof addr === 'string'
      && addr.length > 10
      && addr.length < 130
      && /^(addr1|addr_test1)[a-z0-9]+$/.test(addr);
  }

  function readState() {
    var empty = { connected: false, wallet: null, address: null };
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return empty;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.wallet) return empty;


      if (WALLET_KEYS.indexOf(parsed.wallet) === -1) return empty;
      var addr = (parsed.address && isPlausibleAddress(parsed.address)) ? parsed.address : null;
      if (typeof parsed.ts !== 'number' || (Date.now() - parsed.ts) > MAX_SESSION_AGE_MS) {
        return empty;
      }

      return { connected: true, wallet: parsed.wallet, address: addr };
    } catch (e) {
      return empty;
    }
  }

  function writeState(state) {
    try {
      if (!state || !state.connected || WALLET_KEYS.indexOf(state.wallet) === -1) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          wallet: state.wallet,
          address: (state.address && isPlausibleAddress(state.address)) ? state.address : null,
          ts: Date.now()
        }));
      }
    } catch (e) { }
    notify(readState());
  }

  var listeners = [];
  function notify(state) {
    listeners.forEach(function (cb) {
      try { cb(state); } catch (e) { }
    });
    try {
      global.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: state }));
    } catch (e) {  }
  }

  global.addEventListener('storage', function (ev) {
    if (ev.key === STORAGE_KEY) notify(readState());
  });

  var detectionListeners = [];
  function notifyDetectionChange() {
    detectionListeners.forEach(function (cb) {
      try { cb(); } catch (e) { }
    });
  }

  function truncate(addr) {
    if (!addr || addr.length < 12) return addr || '';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  var enabledApis = {}; 

  function getRealWallet(key) {
    var cardano = global.cardano;
    return (cardano && cardano[key]) ? cardano[key] : null;
  }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message)); }, ms);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  function getOrCreateApi(key) {
    if (enabledApis[key]) return Promise.resolve(enabledApis[key]);
    var wallet = getRealWallet(key);
    if (!wallet) return Promise.reject(new Error('Wallet not available in this page context.'));
    return withTimeout(wallet.enable(), 60000, 'Connection request timed out. Please try again.').then(function (api) {
      enabledApis[key] = api;
      return api;
    });
  }

  var READ_METHODS = [
    'isEnabled', 'getUsedAddresses', 'getUnusedAddresses', 'getChangeAddress',
    'getRewardAddresses', 'getBalance', 'getUtxos', 'getCollateral', 'getNetworkId'
  ];
  var SIGN_METHODS = ['signTx', 'submitTx', 'signData'];
  var ALLOWED_SIGNING_PAGES = ['swap.html'];

  function frameIsAllowedToSign(source) {
    try {
      var path = source.location.pathname || '';
      var page = path.substring(path.lastIndexOf('/') + 1);
      return ALLOWED_SIGNING_PAGES.indexOf(page) !== -1;
    } catch (e) {

      return false;
    }
  }

  if (isTopFrame) {
    global.addEventListener('message', function (ev) {
      if (ev.origin !== location.origin) return;
      var msg = ev.data;
      if (!msg || msg.tag !== RPC_TAG || msg.type !== 'request') return;

      var reply = function (payload) {
        try { ev.source.postMessage(Object.assign({ tag: RPC_TAG, type: 'response', id: msg.id }, payload), location.origin); }
        catch (e) { }
      };

      if (msg.action === 'detect') {
        reply({ ok: true, result: WALLET_KEYS.filter(function (k) { return !!getRealWallet(k); }) });
        return;
      }

      if (WALLET_KEYS.indexOf(msg.walletKey) === -1) {
        reply({ ok: false, error: 'Unknown wallet.' });
        return;
      }

      if (msg.action === 'isEnabled') {
        var w = getRealWallet(msg.walletKey);
        if (!w || typeof w.isEnabled !== 'function') { reply({ ok: true, result: false }); return; }
        w.isEnabled().then(function (r) { reply({ ok: true, result: !!r }); })
          .catch(function () { reply({ ok: true, result: false }); });
        return;
      }

      if (msg.action === 'enable') {
        getOrCreateApi(msg.walletKey).then(function () { reply({ ok: true, result: true }); })
          .catch(function (e) { reply({ ok: false, error: (e && e.message) || 'Could not connect.' }); });
        return;
      }

      var isReadMethod = READ_METHODS.indexOf(msg.method) !== -1;
      var isSignMethod = SIGN_METHODS.indexOf(msg.method) !== -1;

      if (!isReadMethod && !isSignMethod) {
        reply({ ok: false, error: 'Unknown wallet method.' });
        return;
      }
      if (isSignMethod && !frameIsAllowedToSign(ev.source)) {
        reply({ ok: false, error: 'This page is not allowed to request wallet signatures.' });
        return;
      }

      getOrCreateApi(msg.walletKey).then(function (api) {
        if (typeof api[msg.method] !== 'function') {
          throw new Error('Wallet does not support ' + msg.method + '.');
        }
        return api[msg.method].apply(api, msg.args || []);
      }).then(function (result) {
        reply({ ok: true, result: result });
      }).catch(function (e) {
        reply({ ok: false, error: (e && e.message) || 'Wallet call failed.' });
      });
    });
  }

  var rpcSeq = 0;
  var rpcPending = {};
  if (!isTopFrame) {
    global.addEventListener('message', function (ev) {
      if (ev.origin !== location.origin) return;
      var msg = ev.data;
      if (!msg || msg.tag !== RPC_TAG || msg.type !== 'response') return;
      var pending = rpcPending[msg.id];
      if (!pending) return;
      delete rpcPending[msg.id];
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error || 'Wallet call failed.'));
    });
  }

  function rpcCall(action, walletKey, method, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!global.parent || global.parent === global) {
        reject(new Error('No parent frame to bridge the wallet through.'));
        return;
      }
      var id = 'wb' + (++rpcSeq) + '_' + Date.now();
      var timer = setTimeout(function () {
        delete rpcPending[id];
        reject(new Error('Wallet request timed out.'));
      }, timeoutMs || 60000);
      rpcPending[id] = {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
      global.parent.postMessage({
        tag: RPC_TAG, type: 'request', id: id,
        action: action, walletKey: walletKey, method: method, args: args
      }, location.origin);
    });
  }

  var CIP30_METHODS = READ_METHODS.concat(SIGN_METHODS);
  function makeProxyWallet(key) {
    var proxy = {};
    proxy.enable = function () { return rpcCall('enable', key, null, null).then(function () { return proxy; }); };
    CIP30_METHODS.forEach(function (method) {
      proxy[method] = function () {
        var args = Array.prototype.slice.call(arguments);
        return rpcCall('call', key, method, args);
      };
    });
    return proxy;
  }

  var iframeDetected = {}; 
  var iframeDetectionAttempted = false;
  function pollDetectionFromParent() {
    if (isTopFrame) return;
    iframeDetectionAttempted = true;
    var tries = 0;
    var maxTries = 24;
    var timer = setInterval(function () {
      tries++;
      rpcCall('detect', null, null, null, 3000).then(function (keys) {
        var next = {};
        (keys || []).forEach(function (k) { next[k] = true; });
        var changed = JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(iframeDetected).sort());
        iframeDetected = next;
        if (changed) notifyDetectionChange();
        if (tries >= maxTries || WALLET_KEYS.every(function (k) { return !!next[k]; })) {
          clearInterval(timer);
        }
      }).catch(function () {
        if (tries >= maxTries) clearInterval(timer);
      });
    }, 400);
  }
  if (!isTopFrame) pollDetectionFromParent();

  function getInjectedWallet(key) {
    if (isTopFrame) return getRealWallet(key);
    if (!iframeDetectionAttempted) pollDetectionFromParent();
    return iframeDetected[key] ? makeProxyWallet(key) : null;
  }

  function isInstalled(key) {
    return !!getInjectedWallet(key);
  }

  function waitForWallet(key, opts) {
    opts = opts || {};
    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 5000;
    var intervalMs = typeof opts.intervalMs === 'number' ? opts.intervalMs : 150;
    var existing = getInjectedWallet(key);
    if (existing) return Promise.resolve(existing);
    return new Promise(function (resolve) {
      var elapsed = 0;
      var timer = setInterval(function () {
        elapsed += intervalMs;
        var wallet = getInjectedWallet(key);
        if (wallet || elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(wallet || null);
        }
      }, intervalMs);
    });
  }

  var BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  function bech32Polymod(values) {
    var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var chk = 1;
    for (var p = 0; p < values.length; p++) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[p];
      for (var i = 0; i < 5; i++) {
        if ((top >>> i) & 1) chk ^= GEN[i];
      }
    }
    return chk >>> 0;
  }

  function bech32HrpExpand(hrp) {
    var ret = [];
    for (var i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
    ret.push(0);
    for (var i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
    return ret;
  }

  function bech32CreateChecksum(hrp, data) {
    var values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    var mod = bech32Polymod(values) ^ 1;
    var ret = [];
    for (var p = 0; p < 6; p++) ret.push((mod >>> (5 * (5 - p))) & 31);
    return ret;
  }

  function bech32Encode(hrp, data) {
    var combined = data.concat(bech32CreateChecksum(hrp, data));
    var ret = hrp + '1';
    for (var p = 0; p < combined.length; p++) ret += BECH32_CHARSET.charAt(combined[p]);
    return ret;
  }

  function convertBits(data, fromBits, toBits, pad) {
    var acc = 0, bits = 0, ret = [];
    var maxv = (1 << toBits) - 1;
    for (var i = 0; i < data.length; i++) {
      acc = ((acc << fromBits) | data[i]) >>> 0;
      bits += fromBits;
      while (bits >= toBits) {
        bits -= toBits;
        ret.push((acc >>> bits) & maxv);
      }
    }
    if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
    return ret;
  }

  function hexToBytes(hex) {
    var bytes = [];
    for (var i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    return bytes;
  }

  function cip30AddressToBech32(hex) {
    try {
      if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
        return null;
      }
      var bytes = hexToBytes(hex);
      if (!bytes.length) return null;
      var networkId = bytes[0] & 0x0f;
      var hrp = networkId === 1 ? 'addr' : 'addr_test';
      var fiveBit = convertBits(bytes, 8, 5, true);
      return fiveBit ? bech32Encode(hrp, fiveBit) : null;
    } catch (e) {
      return null;
    }
  }


  function extractAddress(api) {
    var tryUsed = (typeof api.getUsedAddresses === 'function')
      ? api.getUsedAddresses().catch(function () { return []; })
      : Promise.resolve([]);

    return tryUsed.then(function (used) {
      if (used && used.length) return used[0];
      if (typeof api.getChangeAddress === 'function') {
        return api.getChangeAddress().catch(function () { return null; });
      }
      return null;
    }).then(function (rawHex) {
      return rawHex ? cip30AddressToBech32(rawHex) : null;
    });
  }

  function connect(key) {
    if (WALLET_KEYS.indexOf(key) === -1) {
      return Promise.reject(new Error('Unknown wallet.'));
    }
    var wallet = getInjectedWallet(key);
    if (!wallet) {
      return Promise.reject(new Error(
        ((WALLETS.find(function (w) { return w.key === key; }) || {}).name || key)
        + ' is not installed in this browser.'
      ));
    }
    var enablePromise = isTopFrame ? getOrCreateApi(key) : wallet.enable();
    return enablePromise.then(function (api) {
      return extractAddress(api).then(function (rawAddr) {
        var state = { connected: true, wallet: key, address: rawAddr || null };
        writeState(state);
        return readState();
      });
    });
  }

  function disconnect() {
    var wallet = readState().wallet;
    if (wallet && enabledApis[wallet]) delete enabledApis[wallet];
    writeState({ connected: false, wallet: null, address: null });
  }

  function attemptSilentReconnect() {
    var state = readState();
    if (!state.connected) return Promise.resolve(state);
    return waitForWallet(state.wallet, { timeoutMs: 5000 }).then(function (wallet) {
      if (!wallet || typeof wallet.isEnabled !== 'function') return state;
      return wallet.isEnabled().then(function (ok) {
        if (!ok) {
          writeState({ connected: false, wallet: null, address: null });
          return readState();
        }
        return state;
      }).catch(function () { return state; });
    });
  }

  function buildIconEl(w, size) {
    size = size || 48;
    var ic = document.createElement('span');
    ic.className = 'wb-ic';
    ic.style.color = w.color;
    if (size !== 48) {
      ic.style.width = size + 'px';
      ic.style.height = size + 'px';
      ic.style.borderRadius = Math.round(size * 0.29) + 'px';
    }
    if (w.iconUrl) {
      var img = document.createElement('img');
      img.src = w.iconUrl;
      img.alt = w.name + ' logo';
      img.loading = 'lazy';
      if (size !== 48) {
        var imgSize = Math.round(size * (34 / 48));
        img.style.width = imgSize + 'px';
        img.style.height = imgSize + 'px';
      }
      img.onerror = function () { ic.innerHTML = w.icon; };
      ic.appendChild(img);
    } else {
      ic.innerHTML = w.icon;
      if (size !== 48) {
        var svgSize = Math.round(size * (24 / 48));
        ic.firstChild.style.width = svgSize + 'px';
        ic.firstChild.style.height = svgSize + 'px';
      }
    }
    return ic;
  }

  var PICKER_STYLE_ID = 'walletbridge-picker-styles';
  function ensurePickerStyles() {
    if (document.getElementById(PICKER_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = PICKER_STYLE_ID;
    style.textContent =
      '.wb-picker-backdrop{position:fixed;inset:0;z-index:400;background:rgba(6,14,24,0.65);' +
      'backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px;' +
      'opacity:0;pointer-events:none;transition:opacity .18s ease;}' +
      '.wb-picker-backdrop.wb-open{opacity:1;pointer-events:auto;}' +
      '.wb-picker{width:100%;max-width:400px;background:var(--ocean-mid,#123b5e);' +
      'border:1px solid var(--line,rgba(127,219,202,0.14));border-radius:18px;padding:22px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,0.45);transform:translateY(10px) scale(.98);' +
      'transition:transform .18s ease;max-height:82vh;overflow-y:auto;font-family:var(--font-sans,Inter,sans-serif);color:var(--white,#fff);}' +
      '.wb-picker-backdrop.wb-open .wb-picker{transform:translateY(0) scale(1);}' +
      '.wb-picker-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;}' +
      '.wb-picker-head h3{font-family:var(--font-display,Orbitron,sans-serif);font-size:16.5px;font-weight:800;margin:0;}' +
      '.wb-picker-close{width:30px;height:30px;border-radius:9px;flex-shrink:0;background:rgba(255,255,255,0.04);' +
      'border:1px solid var(--line,rgba(127,219,202,0.14));color:var(--text-soft,#c8dbe8);cursor:pointer;font-size:14px;line-height:1;}' +
      '.wb-picker-close:hover{border-color:var(--coral,#ff6b6b);color:var(--coral,#ff6b6b);}' +
      '.wb-picker-sub{color:var(--text-dim,#7a9bb5);font-size:12.5px;margin:6px 0 18px;}' +
      '.wb-picker-list{display:flex;flex-direction:column;gap:10px;}' +
      '.wb-wallet-btn{display:flex;align-items:center;gap:14px;padding:14px 16px;background:rgba(255,255,255,0.02);' +
      'border:1.5px solid var(--line,rgba(127,219,202,0.14));border-radius:16px;cursor:pointer;text-align:left;width:100%;' +
      'font:inherit;color:inherit;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease,transform .1s ease;}' +
      '.wb-wallet-btn:hover{border-color:var(--seafoam,#7fdbca);background:rgba(127,219,202,0.07);' +
      'box-shadow:0 8px 22px rgba(0,0,0,0.3);transform:translateY(-1px);}' +
      '.wb-wallet-btn:active{transform:translateY(0);}' +
      '.wb-wallet-btn .wb-ic{width:48px;height:48px;border-radius:14px;flex-shrink:0;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(255,255,255,0.06);' +
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,0.09);overflow:hidden;}' +
      '.wb-wallet-btn .wb-ic svg{width:24px;height:24px;}' +
      '.wb-wallet-btn .wb-ic img{width:34px;height:34px;object-fit:contain;}' +
      '.wb-wallet-btn .wb-body{flex:1;min-width:0;}' +
      '.wb-wallet-btn .wb-name-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
      '.wb-wallet-btn .wb-name{font-size:14.5px;font-weight:800;letter-spacing:.1px;}' +
      '.wb-badge-recommended{font-size:9px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;' +
      'color:#3a2405;background:linear-gradient(135deg,#ffe9a8,var(--gold,#ffd93d));padding:3px 8px;border-radius:999px;' +
      'box-shadow:0 0 10px rgba(255,217,61,0.35);}' +
      '.wb-wallet-btn .wb-status{font-size:11px;color:var(--text-dim,#7a9bb5);margin-top:3px;}' +
      '.wb-wallet-btn .wb-arrow{color:var(--text-dim,#7a9bb5);font-size:17px;flex-shrink:0;opacity:.65;' +
      'transition:transform .15s ease,opacity .15s ease;}' +
      '.wb-wallet-btn:hover .wb-arrow{opacity:1;transform:translateX(2px);}' +
      '.wb-wallet-btn.wb-not-installed .wb-status{color:var(--gold,#ffd93d);}' +
      '.wb-wallet-btn.wb-not-installed .wb-arrow{color:var(--gold,#ffd93d);}' +
      '.wb-wallet-btn.wb-connecting{opacity:.55;pointer-events:none;}' +
      '.wb-wallet-btn.wb-active{border-color:var(--seafoam,#7fdbca);background:rgba(127,219,202,0.1);' +
      'box-shadow:0 0 0 1px rgba(127,219,202,0.25);}' +
      '.wb-picker-disconnect{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:10px;' +
      'padding:11px;border-radius:12px;border:1px solid var(--line,rgba(127,219,202,0.14));background:transparent;' +
      'color:var(--coral,#ff6b6b);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;}' +
      '.wb-picker-disconnect:hover{border-color:rgba(255,107,107,0.4);background:rgba(255,107,107,0.06);}';
    document.head.appendChild(style);
  }

  function createPicker(opts) {
    opts = opts || {};
    ensurePickerStyles();

    var backdrop = document.createElement('div');
    backdrop.className = 'wb-picker-backdrop';
    backdrop.innerHTML =
      '<div class="wb-picker" role="dialog" aria-modal="true">' +
      '  <div class="wb-picker-head"><h3>' + (opts.title || 'Connect a wallet') + '</h3>' +
      '    <button type="button" class="wb-picker-close" aria-label="Close">&times;</button></div>' +
      '  <p class="wb-picker-sub">' + (opts.subtitle || 'Select a wallet extension. If it\'s not installed, we\'ll take you to get it.') + '</p>' +
      '  <div class="wb-picker-list"></div>' +
      '  <button type="button" class="wb-picker-disconnect" style="display:none;">Disconnect</button>' +
      '</div>';
    document.body.appendChild(backdrop);

    var list = backdrop.querySelector('.wb-picker-list');
    var closeBtn = backdrop.querySelector('.wb-picker-close');
    var disconnectBtn = backdrop.querySelector('.wb-picker-disconnect');
    var connectingKey = null;

    function open() { render(); backdrop.classList.add('wb-open'); }
    function close() { backdrop.classList.remove('wb-open'); }

    function render() {
      var state = readState();
      list.innerHTML = '';
      WALLETS.forEach(function (w) {
        var installed = isInstalled(w.key);
        var isActive = state.connected && state.wallet === w.key;
        var isConnecting = connectingKey === w.key;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wb-wallet-btn'
          + (installed ? '' : ' wb-not-installed')
          + (isActive ? ' wb-active' : '')
          + (isConnecting ? ' wb-connecting' : '');
        var statusText = isConnecting ? 'Connecting…' : isActive ? 'Connected' : installed ? 'Browser extension' : 'Not installed — click to get it';
        var badge = w.recommended ? '<span class="wb-badge-recommended">Recommended</span>' : '';
        btn.innerHTML =
          '<span class="wb-body"><span class="wb-name-row"><span class="wb-name">' + w.name + '</span>' + badge + '</span>' +
          '<span class="wb-status">' + statusText + '</span></span>' +
          '<span class="wb-arrow">' + (installed ? '\u203a' : '\u2197') + '</span>';

        btn.insertBefore(buildIconEl(w), btn.firstChild);
        btn.addEventListener('click', function () {
          if (isConnecting) return;
          if (!installed) { window.open(w.installUrl, '_blank', 'noopener'); return; }
          connectingKey = w.key;
          render();
          connect(w.key).then(function () {
            connectingKey = null;
            close();
            if (typeof opts.onConnected === 'function') opts.onConnected(readState());
          }).catch(function (err) {
            connectingKey = null;
            render();
            if (typeof opts.onError === 'function') opts.onError(err);
          });
        });
        list.appendChild(btn);
      });
      disconnectBtn.style.display = state.connected ? 'flex' : 'none';
    }

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    disconnectBtn.addEventListener('click', function () {
      disconnect();
      close();
    });
    var offChange = onChange(function () { if (backdrop.classList.contains('wb-open')) render(); });
    var offDetect = onDetectionChange(function () { if (backdrop.classList.contains('wb-open')) render(); });

    return {
      open: open,
      close: close,
      isOpen: function () { return backdrop.classList.contains('wb-open'); },
      destroy: function () {
        offChange();
        offDetect();
        backdrop.remove();
      }
    };
  }

  function onChange(cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (l) { return l !== cb; }); }; }
  function onDetectionChange(cb) { detectionListeners.push(cb); return function () { detectionListeners = detectionListeners.filter(function (l) { return l !== cb; }); }; }

  var CHIP_STYLE_ID = 'walletbridge-chip-styles';
  function ensureChipStyles() {
    if (document.getElementById(CHIP_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = CHIP_STYLE_ID;
    style.textContent =
      '.wb-chip,.wb-chip-connect{display:inline-flex;align-items:center;font:inherit;color:inherit;' +
      'cursor:pointer;border:1px solid var(--line,rgba(127,219,202,0.14));border-radius:999px;' +
      'background:rgba(255,255,255,0.03);transition:border-color .15s ease,background .15s ease;}' +
      '.wb-chip:hover,.wb-chip-connect:hover{border-color:var(--seafoam,#7fdbca);background:rgba(127,219,202,0.07);}' +
      '.wb-chip{gap:8px;padding:5px 14px 5px 5px;}' +
      '.wb-chip-connect{gap:6px;padding:9px 16px;font-size:12.5px;font-weight:700;}' +
      '.wb-chip .wb-ic{box-shadow:inset 0 0 0 1px rgba(255,255,255,0.09);}' +
      '.wb-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--seafoam,#7fdbca);flex-shrink:0;' +
      'box-shadow:0 0 6px var(--seafoam,#7fdbca);}' +
      '.wb-chip-text{display:flex;flex-direction:column;line-height:1.2;text-align:left;}' +
      '.wb-chip-name{font-size:12.5px;font-weight:700;}' +
      '.wb-chip-addr{font-size:10.5px;color:var(--text-dim,#7a9bb5);font-variant-numeric:tabular-nums;}';
    document.head.appendChild(style);
  }

  function createChip(mount, opts) {
    opts = opts || {};
    ensureChipStyles();
    var el = (typeof mount === 'string') ? document.querySelector(mount) : mount;
    if (!el) return null;

    function render() {
      var state = readState();
      el.innerHTML = '';

      if (!state.connected) {
        var connectBtn = document.createElement('button');
        connectBtn.type = 'button';
        connectBtn.className = 'wb-chip-connect';
        connectBtn.textContent = opts.connectLabel || 'Connect wallet';
        connectBtn.addEventListener('click', function () {
          if (typeof opts.onClick === 'function') opts.onClick(state);
        });
        el.appendChild(connectBtn);
        return;
      }

      var w = null;
      for (var i = 0; i < WALLETS.length; i++) { if (WALLETS[i].key === state.wallet) { w = WALLETS[i]; break; } }
      if (!w) return;

      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'wb-chip';
      chip.appendChild(buildIconEl(w, 26));

      var text = document.createElement('span');
      text.className = 'wb-chip-text';
      text.innerHTML =
        '<span class="wb-chip-name">' + w.name + '</span>'
        + (state.address ? '<span class="wb-chip-addr">' + truncate(state.address) + '</span>' : '');
      chip.appendChild(text);

      var dot = document.createElement('span');
      dot.className = 'wb-chip-dot';
      chip.insertBefore(dot, chip.firstChild);

      chip.addEventListener('click', function () {
        if (typeof opts.onClick === 'function') opts.onClick(state);
      });
      el.appendChild(chip);
    }

    render();
    var offChange = onChange(render);
    var offDetect = onDetectionChange(render);

    return {
      refresh: render,
      destroy: function () {
        offChange();
        offDetect();
        el.innerHTML = '';
      }
    };
  }

  global.WalletBridge = Object.freeze({
    WALLETS: WALLETS,
    getState: readState,
    isInstalled: isInstalled,
    waitForWallet: waitForWallet,
    buildIconEl: buildIconEl,
    connect: connect,
    disconnect: disconnect,
    truncate: truncate,
    onChange: onChange,
    onDetectionChange: onDetectionChange,
    attemptSilentReconnect: attemptSilentReconnect,
    createPicker: createPicker,
    createChip: createChip
  });
})(window);
