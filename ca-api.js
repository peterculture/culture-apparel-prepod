/**
 * ca-api.js — Culture Apparel same-origin API client for the Cloudflare
 * Pages Functions proxy (functions/api/*). Every dashboard imports this so
 * the wiring lives in one place. All calls are same-origin (no CORS); the
 * Function owns Salesforce auth.
 *
 * Field/route names verified against the repo's functions/api/* handlers.
 * When any dashboard can't reach the API (e.g. opened as a standalone file,
 * or before deploy) callers fall back to their built-in demo data — see each
 * board's load(); this module just throws on non-OK responses.
 */

/* ── identity (shared with the originals via localStorage) ── */
export const ROLE_KEY = 'caShopRole';
export const NAME_KEY = 'caShopWorkerName';
export function role(){ try { return localStorage.getItem(ROLE_KEY) || ''; } catch (_) { return ''; } }
export function workerName(){ try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } }
export function setRole(r){ try { localStorage.setItem(ROLE_KEY, r); } catch (_) {} }
export function setWorkerName(n){ try { localStorage.setItem(NAME_KEY, (n || '').slice(0, 80)); } catch (_) {} }
export function logout(){ try { localStorage.removeItem(ROLE_KEY); localStorage.removeItem(NAME_KEY); } catch (_) {} }

/* ── Order_Substatus__c: the "In Production" label is stored as "Production" ── */
export const SUBSTATUS_VALUE = { 'Pre-Production':'Pre-Production', 'Ready for Print':'Ready for Print', 'In Production':'Production', 'Post-Production':'Post-Production', 'Completed':'Completed' };
export const SUBSTATUS_LABEL = Object.fromEntries(Object.entries(SUBSTATUS_VALUE).map(([label, val]) => [val, label]));
export const STAGE_KEY = { 'Ready for Print':'rfp', 'In Production':'ip', 'Post-Production':'pp', 'Completed':'done' };
export const STAGE_SUBSTATUS = { rfp:'Ready for Print', ip:'In Production', pp:'Post-Production', done:'Completed' };
export function stageOf(rec){ return STAGE_KEY[SUBSTATUS_LABEL[rec.Order_Substatus__c] || rec.Order_Substatus__c] || null; }

/* pre-production checklist label -> Order boolean field */
export const CHECK_FIELD = {
  'Films printed':'Films_Printed__c', 'Screens completed':'Screens_Completed__c', 'Inks mixed':'Mix_Inks__c',
  'File digitized':'Digitize_File__c', 'Thread & materials':'Thread_Color_Materials__c',
  'Transfers received':'Transfers_Received__c', 'Transfers ready':'Transfers_Ready__c',
};
/* Receiving_Status__c picklist <-> board key */
export const RECV_FROM_SF = { 'Not Received':'none', 'Partial':'partial', 'Counted In':'staged', 'Staged':'staged' };
export const RECV_TO_SF = { none:'Not Received', partial:'Partial', staged:'Staged' };

/* ── low-level fetch ── */
async function jget(url){
  const r = await fetch(url, { headers: { Accept:'application/json' } });
  if (!r.ok) throw new Error('GET ' + url + ' → ' + r.status);
  return r.json();
}
async function jsend(url, method, body){
  const r = await fetch(url, { method, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok && r.status !== 204) throw new Error(method + ' ' + url + ' → ' + r.status);
  return r.status === 204 ? null : r.json().catch(() => null);
}

/* ── orders ── */
export async function getOrders(){ const d = await jget('/api/orders'); return d.records || []; }
export function patchOrder(id, fields){
  const body = Object.assign({}, fields);
  const by = workerName(); if (by) body.Last_Updated_By__c = by;
  return jsend('/api/orders/' + encodeURIComponent(id), 'PATCH', body);
}
export async function getOrderSizes(orderId){ const d = await jget('/api/order-sizes?orderId=' + encodeURIComponent(orderId)); return d.records || []; }

/* ── packaging (Order_Packaging__c) ── */
export async function getPackaging(orderId){ const d = await jget('/api/packaging?orderId=' + encodeURIComponent(orderId)); return d.records || []; }
export function postPackaging(orderId, type, qty){ return jsend('/api/packaging', 'POST', { orderId, Packaging_Type__c:type, Quantity__c:qty }); }

/* ── shipments (zkmulti__MCShipment__c) ── */
export async function getShipments(orderId){ const d = await jget('/api/shipments?orderId=' + encodeURIComponent(orderId)); return d.records || []; }
export function postShipment(orderId, { carrier, serviceType, tracking, weight }){ return jsend('/api/shipments', 'POST', { orderId, Carrier:carrier, ServiceType:serviceType, TrackingNumber:tracking, Weight:weight }); }

/* ── station worker board ── */
export async function getStationItems(station){ const d = await jget('/api/station-items?station=' + encodeURIComponent(station)); return d.records || []; }
export function updateItemStatus(station, itemId, subStatus){ const by = workerName(); return jsend('/api/update-item-status', 'POST', { station, itemId, subStatus, by }); }
export function updateOrderReceiving(orderId, status, missing){ const by = workerName(); return jsend('/api/update-order-receiving', 'POST', { station:'garment', orderId, status, missing: missing || '', by }); }
export async function getInventory(type){ const d = await jget('/api/inventory?type=' + encodeURIComponent(type)); return d.items || []; }
export function postInventory(type, items){ return jsend('/api/inventory', 'POST', { type, items }); }
export function stationLogin(station, pin){ return jsend('/api/station-login', 'POST', { station, pin }); }

/* ── mapping helpers ── */
export const SIZE_ORDER = ['YXS','YS','YM','YL','YXL','OS','XS','S','M','L','XL','2XL','3XL','4XL','5XL'];
const WORKER_COLORS = ['#C6372B','#5E9B9A','#C9923A','#7FA644','#8E6FB0','#3E7CB1'];

export function initials(name){
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
export function colorForName(name){
  let h = 0; const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return WORKER_COLORS[h % WORKER_COLORS.length];
}
export function methodOf(rec){
  const p = ((rec.Printer__r && rec.Printer__r.Name) || '').toLowerCase();
  if (/embroid|stitch|thread/.test(p)) return 'em';
  if (/heat|transfer|dtf|vinyl|press/.test(p)) return 'hp';
  if (/screen|print/.test(p)) return 'sp';
  // fall back to whichever method's pre-prod fields are populated
  if (rec.Digitize_File__c || rec.Thread_Color_Materials__c) return 'em';
  if (rec.Transfers_Received__c || rec.Transfers_Ready__c) return 'hp';
  return 'sp';
}
export function dueInfo(printDateISO){
  if (!printDateISO) return { label:'No date', urg:'ok' };
  const d = new Date(printDateISO + 'T12:00:00');
  const today = new Date(); today.setHours(12,0,0,0);
  const days = Math.round((d - today) / 86400000);
  const md = d.toLocaleDateString([], { month:'short', day:'numeric' });
  if (days < 0) return { label:'Overdue · ' + (-days) + 'd', urg:'over' };
  if (days === 0) return { label:'Due today', urg:'today' };
  if (days === 1) return { label:'Due tomorrow', urg:'soon' };
  return { label: md + ' · ' + days + 'd', urg: days <= 2 ? 'soon' : 'ok' };
}
/** Pivot OrderItems (rec.OrderItems.records) into {qty, garment, sizes, sizeCells}. */
export function pivotItems(rec){
  const items = (rec.OrderItems && rec.OrderItems.records) || [];
  const bySize = {}; let total = 0; let garment = '';
  for (const it of items) {
    const sz = (it.Size__c || '').toUpperCase(); const q = Number(it.Quantity) || 0;
    if (!sz) continue;
    bySize[sz] = (bySize[sz] || 0) + q; total += q;
    if (!garment && it.Product2 && it.Product2.Name) garment = it.Product2.Name + (it.Color__c ? ' · ' + it.Color__c : '');
  }
  const keys = Object.keys(bySize).sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return {
    qty: String(total),
    garment: garment || '—',
    sizes: keys.map(k => k + bySize[k]).join(' · '),
    sizeCells: keys.map(k => ({ label:k, qty:String(bySize[k]) })),
  };
}
