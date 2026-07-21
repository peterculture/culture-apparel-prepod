/**
 * ca-api.js — Culture Apparel same-origin API client for the Cloudflare
 * Pages Functions proxy (functions/api/*).
 *
 * Loaded as a CLASSIC script (not an ES module) so it can be inlined straight
 * into each page and exposed as window.CAApi — no runtime import(), no separate
 * file to deploy, no module-resolution surprises. All calls are same-origin
 * (no CORS); the Pages Function owns Salesforce auth.
 *
 * Field/route names verified against functions/api/*. When a page can't reach
 * the API it falls back to its built-in demo data (each board's load() catches
 * the throw and flips the badge to "Demo data").
 */
(function () {
  /* ── identity (shared with the originals via localStorage) ── */
  var ROLE_KEY = 'caShopRole';
  var NAME_KEY = 'caShopWorkerName';
  function role(){ try { return localStorage.getItem(ROLE_KEY) || ''; } catch (_) { return ''; } }
  function workerName(){ try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } }
  function setRole(r){ try { localStorage.setItem(ROLE_KEY, r); } catch (_) {} }
  function setWorkerName(n){ try { localStorage.setItem(NAME_KEY, (n || '').slice(0, 80)); } catch (_) {} }
  function logout(){ try { localStorage.removeItem(ROLE_KEY); localStorage.removeItem(NAME_KEY); } catch (_) {} }

  /* ── Order_Substatus__c: the "In Production" label is stored as "Production" ── */
  var SUBSTATUS_VALUE = { 'Pre-Production':'Pre-Production', 'Ready for Print':'Ready for Print', 'In Production':'Production', 'Post-Production':'Post-Production', 'Completed':'Completed' };
  var SUBSTATUS_LABEL = {}; Object.keys(SUBSTATUS_VALUE).forEach(function (label) { SUBSTATUS_LABEL[SUBSTATUS_VALUE[label]] = label; });
  var STAGE_KEY = { 'Ready for Print':'rfp', 'In Production':'ip', 'Post-Production':'pp', 'Completed':'done' };
  var STAGE_SUBSTATUS = { rfp:'Ready for Print', ip:'In Production', pp:'Post-Production', done:'Completed' };
  function stageOf(rec){ return STAGE_KEY[SUBSTATUS_LABEL[rec.Order_Substatus__c] || rec.Order_Substatus__c] || null; }

  /* pre-production checklist label -> Order boolean field */
  var CHECK_FIELD = {
    'Films printed':'Films_Printed__c', 'Screens completed':'Screens_Completed__c', 'Inks mixed':'Mix_Inks__c',
    'File digitized':'Digitize_File__c', 'Thread & materials':'Thread_Color_Materials__c',
    'Transfers received':'Transfers_Received__c', 'Transfers ready':'Transfers_Ready__c'
  };
  /* Receiving_Status__c picklist <-> board key */
  var RECV_FROM_SF = { 'Not Received':'none', 'Partial':'partial', 'Counted In':'countedin', 'Staged':'staged' };
  var RECV_TO_SF = { none:'Not Received', partial:'Partial', countedin:'Counted In', staged:'Staged' };

  /* ── low-level fetch ── */
  function jget(url){
    return fetch(url, { headers: { Accept:'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('GET ' + url + ' -> ' + r.status);
      return r.json();
    });
  }
  function jsend(url, method, body){
    return fetch(url, { method: method, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) {
      if (!r.ok && r.status !== 204) throw new Error(method + ' ' + url + ' -> ' + r.status);
      return r.status === 204 ? null : r.json().catch(function () { return null; });
    });
  }
  function jdel(url){
    return fetch(url, { method: 'DELETE' }).then(function (r) {
      if (!r.ok && r.status !== 204) throw new Error('DELETE ' + url + ' -> ' + r.status);
      return r.status === 204 ? null : r.json().catch(function () { return null; });
    });
  }

  /* ── orders ── */
  function getOrders(){ return jget('/api/orders').then(function (d) { return d.records || []; }); }
  function getProductionOrders(){ return jget('/api/production-orders').then(function (d) { return d.records || []; }); }
  function getInbox(){ return jget('/api/inbox').then(function (d) { return d.records || []; }); }
  function getPreProductionItems(orderId){ return jget('/api/pre-production-items?orderId=' + encodeURIComponent(orderId)).then(function (d) { return d.records || []; }); }
  function patchItem(itemId, fields){ var b = Object.assign({}, fields); var by = workerName(); if (by) b.Last_Updated_By__c = by; return jsend('/api/pre-production-items/' + encodeURIComponent(itemId), 'PATCH', b); }
  function deleteItem(itemId){ return jdel('/api/pre-production-items/' + encodeURIComponent(itemId)); }
  function searchVendors(q){ return jget('/api/vendors?q=' + encodeURIComponent(q || '')).then(function (d) { return d.records || []; }); }
  function searchPlans(q){ return jget('/api/plans?q=' + encodeURIComponent(q || '')).then(function (d) { return d.records || []; }); }
  function createMethod(body){ return jsend('/api/production-methods', 'POST', body); }
  function patchOrder(id, fields){
    var body = Object.assign({}, fields);
    var by = workerName(); if (by) body.Last_Updated_By__c = by;
    return jsend('/api/orders/' + encodeURIComponent(id), 'PATCH', body);
  }
  function getOrderSizes(orderId){ return jget('/api/order-sizes?orderId=' + encodeURIComponent(orderId)).then(function (d) { return d.records || []; }); }

  /* ── packaging (Order_Packaging__c) ── */
  function getPackaging(orderId){ return jget('/api/packaging?orderId=' + encodeURIComponent(orderId)).then(function (d) { return d.records || []; }); }
  function postPackaging(orderId, type, qty){ return jsend('/api/packaging', 'POST', { orderId: orderId, Packaging_Type__c: type, Quantity__c: qty }); }
  function deletePackaging(pkgId){ return jdel('/api/packaging/' + encodeURIComponent(pkgId)); }

  /* ── shipments (zkmulti__MCShipment__c) ── */
  function getShipments(orderId){ return jget('/api/shipments?orderId=' + encodeURIComponent(orderId)).then(function (d) { return d.records || []; }); }
  function postShipment(orderId, o){ o = o || {}; return jsend('/api/shipments', 'POST', { orderId: orderId, Carrier: o.carrier, ServiceType: o.serviceType, TrackingNumber: o.tracking, Weight: o.weight }); }

  /* ── station worker board ── */
  function getStationItems(station){ return jget('/api/station-items?station=' + encodeURIComponent(station)).then(function (d) { return d.records || []; }); }
  function updateItemStatus(station, itemId, subStatus){ return jsend('/api/update-item-status', 'POST', { station: station, itemId: itemId, subStatus: subStatus, by: workerName() }); }
  function updateOrderReceiving(orderId, status, missing){ return jsend('/api/update-order-receiving', 'POST', { station:'garment', orderId: orderId, status: status, missing: missing || '', by: workerName() }); }
  function getInventory(type){ return jget('/api/inventory?type=' + encodeURIComponent(type)).then(function (d) { return d.items || []; }); }
  function postInventory(type, items){ return jsend('/api/inventory', 'POST', { type: type, items: items }); }
  function stationLogin(station, pin){ return jsend('/api/station-login', 'POST', { station: station, pin: pin }); }

  /* ── mapping helpers ── */
  var SIZE_ORDER = ['YXS','YS','YM','YL','YXL','OS','XS','S','M','L','XL','2XL','3XL','4XL','5XL'];
  var WORKER_COLORS = ['#C6372B','#5E9B9A','#C9923A','#7FA644','#8E6FB0','#3E7CB1'];

  function text(v){ if (v == null) return ''; var s = String(v); if (s.indexOf('<') >= 0) { var el = document.createElement('div'); el.innerHTML = s; s = el.textContent || el.innerText || ''; } return s.replace(/\s+/g, ' ').trim(); }
  function initials(name){
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '\u2014';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function colorForName(name){
    var h = 0, s = String(name || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return WORKER_COLORS[h % WORKER_COLORS.length];
  }
  function methodOf(rec){
    var p = ((rec.Printer__r && rec.Printer__r.Name) || '').toLowerCase();
    if (/embroid|stitch|thread/.test(p)) return 'em';
    if (/heat|transfer|dtf|vinyl|press/.test(p)) return 'hp';
    if (/screen|print/.test(p)) return 'sp';
    if (rec.Digitize_File__c || rec.Thread_Color_Materials__c) return 'em';
    if (rec.Transfers_Received__c || rec.Transfers_Ready__c) return 'hp';
    return 'sp';
  }
  // Salesforce Date fields come back as plain "YYYY-MM-DD" (needs a noon time
  // appended so it doesn't parse as UTC midnight and roll back a day in local
  // time). Salesforce DateTime fields come back already carrying a "T" and an
  // offset (e.g. "2026-07-25T00:00:00.000+0000") -- appending another "T12:00:00"
  // to those corrupts the string and makes every date fail to parse. Detect
  // which shape we got before deciding whether to append anything.
  function parseSfDate(iso){
    if (!iso) return null;
    var s = String(iso);
    var d = s.indexOf('T') >= 0 ? new Date(s) : new Date(s + 'T12:00:00');
    return isNaN(d.getTime()) ? null : d;
  }
  // `days` (integer, or null when there's no date) is exposed alongside the
  // display label/urgency so callers that list many items (station boards)
  // can sort by actual due date instead of re-parsing the label text.
  function dueInfo(printDateISO){
    var d = parseSfDate(printDateISO);
    if (!d) return { label:'No date', urg:'ok', days:null };
    var today = new Date(); today.setHours(12,0,0,0);
    var days = Math.round((d - today) / 86400000);
    var md = d.toLocaleDateString([], { month:'short', day:'numeric' });
    if (days < 0) return { label:'Overdue \u00b7 ' + (-days) + 'd', urg:'over', days:days };
    if (days === 0) return { label:'Due today', urg:'today', days:days };
    if (days === 1) return { label:'Due tomorrow', urg:'soon', days:days };
    return { label: md + ' \u00b7 ' + days + 'd', urg: days <= 2 ? 'soon' : 'ok', days:days };
  }
  function pivotItems(rec){
    var items = (rec.OrderItems && rec.OrderItems.records) || [];
    var bySize = {}, total = 0, garment = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var sz = (it.Size__c || '').toUpperCase(); var q = Number(it.Quantity) || 0;
      if (!sz) continue;
      bySize[sz] = (bySize[sz] || 0) + q; total += q;
      if (!garment && it.Product2 && it.Product2.Name) garment = text(it.Product2.Name) + (it.Color__c ? ' \u00b7 ' + text(it.Color__c) : '');
    }
    var keys = Object.keys(bySize).sort(function (a, b) {
      var ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return {
      qty: String(total),
      garment: garment || '\u2014',
      sizes: keys.map(function (k) { return k + bySize[k]; }).join(' \u00b7 '),
      sizeCells: keys.map(function (k) { return { label:k, qty:String(bySize[k]) }; })
    };
  }

  window.CAApi = {
    ROLE_KEY: ROLE_KEY, NAME_KEY: NAME_KEY, role: role, workerName: workerName, setRole: setRole, setWorkerName: setWorkerName, logout: logout,
    SUBSTATUS_VALUE: SUBSTATUS_VALUE, SUBSTATUS_LABEL: SUBSTATUS_LABEL, STAGE_KEY: STAGE_KEY, STAGE_SUBSTATUS: STAGE_SUBSTATUS, stageOf: stageOf,
    CHECK_FIELD: CHECK_FIELD, RECV_FROM_SF: RECV_FROM_SF, RECV_TO_SF: RECV_TO_SF,
    getOrders: getOrders, getProductionOrders: getProductionOrders, getInbox: getInbox, getPreProductionItems: getPreProductionItems, patchItem: patchItem, deleteItem: deleteItem, searchVendors: searchVendors, searchPlans: searchPlans, createMethod: createMethod, patchOrder: patchOrder, getOrderSizes: getOrderSizes,
    getPackaging: getPackaging, postPackaging: postPackaging, deletePackaging: deletePackaging,
    getShipments: getShipments, postShipment: postShipment,
    getStationItems: getStationItems, updateItemStatus: updateItemStatus, updateOrderReceiving: updateOrderReceiving,
    getInventory: getInventory, postInventory: postInventory, stationLogin: stationLogin,
    SIZE_ORDER: SIZE_ORDER, text: text, initials: initials, colorForName: colorForName, methodOf: methodOf, dueInfo: dueInfo, parseSfDate: parseSfDate, pivotItems: pivotItems
  };
})();
