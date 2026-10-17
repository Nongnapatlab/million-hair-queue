/**
 * Million Hair — Virtual Queue backend (Google Apps Script, bound to the Google Sheet)
 *
 * Script Properties (Project Settings → Script properties):
 *   LINE_TOKEN        Channel access token (long-lived) ของ Messaging API channel
 *   LOGIN_CHANNEL_ID  Channel ID ของ LINE Login channel (MillionHair Queue App)
 *
 * ครั้งแรก หรือหลังเพิ่มคอลัมน์: รัน setup() 1 ครั้งจาก editor (หัวตาราง, Dropdown, trigger)
 */

const SHEET_NAME = 'Queue';
const TZ = 'Asia/Bangkok';

// ข้อมูลร้าน (ร้านสมมติสำหรับโครงงาน) — หน้า LIFF ดึงจากตรงนี้ จึงแก้ที่เดียว
const SHOP = {
  name: 'Million Hair',
  tagline: 'หนึ่งในล้าน ไม่ต้องรอ',
  hours: 'เปิดทุกวัน 10:00–20:00 น. (หยุดวันพุธ)',
  address: '[ที่อยู่ร้านสมมติ]',
  phone: '[เบอร์ร้านสมมติ]',
};
const SERVICES = [ // name, นาทีโดยประมาณ (ใช้คำนวณเวลารอ), ราคา
  { name: 'ตัดผมสั้น', min: 30, price: '150' },
  { name: 'ตัดผมยาว', min: 45, price: '200' },
  { name: 'สระ-ไดร์', min: 30, price: '150' },
  { name: 'ตัด + สระ-ไดร์', min: 60, price: '300' },
  { name: 'ทรีตเมนต์บำรุงผม', min: 45, price: '350' },
  { name: 'ทำสีผม', min: 120, price: 'เริ่มต้น 900' },
  { name: 'ดัด / ยืดผม', min: 150, price: 'เริ่มต้น 1,200' },
];
const ANY_STYLIST = 'ไม่ระบุ (คิวเร็วที่สุด)';
const STYLISTS = [
  { name: 'ช่างมิน', skill: 'ตัดทรงเกาหลี · ผมสั้น' },
  { name: 'ช่างแนท', skill: 'ทำสี · ดัด · ยืด' },
];

const STATUS = {
  WAITING: 'รอคิว',
  NEAR: 'ใกล้ถึงคิว',
  SERVING: 'รับบริการ',
  DONE: 'เสร็จสิ้น',
  NO_SHOW: 'ไม่มา',
};
const HEADERS = ['Timestamp', 'Queue No', 'Name', 'Service', 'Status', 'LINE User ID',
  'Called At', 'Started At', 'Finished At', 'Channel', 'Phone', 'Stylist', 'Note', 'Visit No'];
const COL = {
  TS: 1, NO: 2, NAME: 3, SERVICE: 4, STATUS: 5, UID: 6, CALLED: 7, STARTED: 8, FINISHED: 9,
  CHANNEL: 10, PHONE: 11, STYLIST: 12, NOTE: 13, VISIT: 14,
};
const ACTIVE = [STATUS.WAITING, STATUS.NEAR];

// ---------- setup ----------

function setup() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.hideColumns(COL.UID);

  const n = sh.getMaxRows() - 1;
  const list = values => SpreadsheetApp.newDataValidation().requireValueInList(values, true).build();
  sh.getRange(2, COL.STATUS, n, 1).setDataValidation(list(Object.values(STATUS)));
  sh.getRange(2, COL.SERVICE, n, 1).setDataValidation(list(SERVICES.map(s => s.name)));
  sh.getRange(2, COL.CHANNEL, n, 1).setDataValidation(list(['LINE', 'Walk-in']));
  sh.getRange(2, COL.STYLIST, n, 1).setDataValidation(list([ANY_STYLIST, ...STYLISTS.map(s => s.name)]));

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onStatusEdit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(ss).onEdit().create();
}

// ---------- Web App (LIFF ↔ Sheets) ----------

function doGet(e) {
  const action = (e.parameter.action || '').toLowerCase();
  if (action === 'config') {
    return json_({ ok: true, shop: SHOP, services: SERVICES, stylists: STYLISTS, anyStylist: ANY_STYLIST });
  }
  if (action === 'busy') return json_(busyHours_());
  return json_({ ok: true, app: 'Million Hair Queue' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const userId = verifyIdToken_(body.idToken);
    if (body.action === 'status') return json_(statusOf_(userId));
    if (body.action === 'join') return json_(join_(userId, body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function join_(userId, body) {
  const name = String(body.name || '').trim().slice(0, 50);
  const service = SERVICES.find(s => s.name === body.service);
  const stylist = [ANY_STYLIST, ...STYLISTS.map(s => s.name)].includes(body.stylist) ? body.stylist : ANY_STYLIST;
  const phone = String(body.phone || '').replace(/\D/g, '');
  const note = String(body.note || '').trim().slice(0, 200);
  if (!name) throw new Error('กรุณากรอกชื่อ');
  if (!service) throw new Error('กรุณาเลือกบริการ');
  if (phone && !/^0\d{8,9}$/.test(phone)) throw new Error('เบอร์โทรไม่ถูกต้อง');
  if (body.consent !== true) throw new Error('ต้องยินยอมให้เก็บข้อมูลก่อนลงคิว');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const existing = statusOf_(userId);
    if (existing.inQueue) return existing; // กันลงคิวซ้ำ

    const queueNo = todayRows_().length + 1;
    const visitNo = allRows_().filter(r => r.uid === userId).length + 1;
    // ใส่ ' นำหน้าเบอร์ ไม่ให้ Sheets ตัดเลข 0 ข้างหน้า
    sheet_().appendRow([new Date(), queueNo, name, service.name, STATUS.WAITING, userId,
      '', '', '', 'LINE', phone ? "'" + phone : '', stylist, note, visitNo]);
  } finally {
    lock.releaseLock();
  }
  return statusOf_(userId);
}

/** สถานะคิวของ user วันนี้ + จำนวนคิวก่อนหน้า + เวลารอโดยประมาณ (นาที) */
function statusOf_(userId) {
  const rows = todayRows_();
  const mine = rows.find(r => r.uid === userId && (ACTIVE.includes(r.status) || r.status === STATUS.SERVING));
  if (!mine) return { ok: true, inQueue: false };

  const base = {
    ok: true, inQueue: true, queueNo: mine.no, status: mine.status, name: mine.name,
    service: mine.service, stylist: mine.stylist, visitNo: mine.visit,
    price: (SERVICES.find(s => s.name === mine.service) || {}).price || '',
  };
  if (mine.status === STATUS.SERVING) return { ...base, ahead: 0, waitMin: 0 };

  const minutesOf = r => (SERVICES.find(s => s.name === r.service) || { min: 30 }).min;
  const before = rows.filter(r => r.row < mine.row);
  const ahead = before.filter(r => ACTIVE.includes(r.status));
  const serving = rows.filter(r => r.status === STATUS.SERVING);

  let minutes;
  if (mine.stylist && mine.stylist !== ANY_STYLIST) {
    // รอเฉพาะคิวของช่างคนนี้ + ครึ่งหนึ่งของคิวที่ไม่ระบุช่าง
    const same = r => r.stylist === mine.stylist;
    const any = r => !r.stylist || r.stylist === ANY_STYLIST;
    minutes = ahead.filter(same).reduce((s, r) => s + minutesOf(r), 0)
      + ahead.filter(any).reduce((s, r) => s + minutesOf(r), 0) / 2
      + serving.filter(same).reduce((s, r) => s + minutesOf(r) / 2, 0);
  } else {
    minutes = (ahead.reduce((s, r) => s + minutesOf(r), 0)
      + serving.reduce((s, r) => s + minutesOf(r) / 2, 0)) / STYLISTS.length;
  }
  return { ...base, ahead: ahead.length, waitMin: Math.round(minutes) };
}

/** จำนวนคิวเฉลี่ยรายชั่วโมงย้อนหลัง 28 วัน (ไม่มีข้อมูลส่วนบุคคล) */
function busyHours_() {
  const since = Date.now() - 28 * 24 * 3600 * 1000;
  const rows = allRows_().filter(r => r.ts instanceof Date && r.ts.getTime() >= since);
  const days = new Set(rows.map(r => Utilities.formatDate(r.ts, TZ, 'yyyy-MM-dd'))).size;
  const counts = {};
  for (let h = 10; h < 20; h++) counts[h] = 0;
  rows.forEach(r => {
    const h = Number(Utilities.formatDate(r.ts, TZ, 'H'));
    if (h in counts) counts[h]++;
  });
  const hours = Object.keys(counts).map(h => ({ hour: Number(h), avg: days ? counts[h] / days : 0 }));
  return { ok: true, days, hours };
}

// ---------- Staff edits status → stamp time + push ----------

function onStatusEdit(e) {
  const range = e.range;
  const sh = range.getSheet();
  if (sh.getName() !== SHEET_NAME || range.getColumn() !== COL.STATUS || range.getRow() < 2) return;
  if (range.getNumRows() !== 1) return;

  const row = range.getRow();
  const status = range.getValue();
  const now = new Date();
  const stamp = col => { if (!sh.getRange(row, col).getValue()) sh.getRange(row, col).setValue(now); };

  if (status === STATUS.NEAR) {
    stamp(COL.CALLED);
    const v = sh.getRange(row, 1, 1, HEADERS.length).getValues()[0];
    const [no, name, uid, stylist] = [v[COL.NO - 1], v[COL.NAME - 1], v[COL.UID - 1], v[COL.STYLIST - 1]];
    if (uid) {
      const who = stylist && stylist !== ANY_STYLIST ? `\n${stylist}พร้อมให้บริการแล้ว` : '';
      push_(uid, `✂️ คุณ${name} ใกล้ถึงคิวแล้ว (คิวที่ ${no})${who}\nกรุณากลับมาที่ร้าน ${SHOP.name} ภายใน 10 นาทีนะคะ`);
    }
  } else if (status === STATUS.SERVING) {
    stamp(COL.CALLED);
    stamp(COL.STARTED);
  } else if (status === STATUS.DONE || status === STATUS.NO_SHOW) {
    stamp(COL.FINISHED);
  }
}

// ---------- helpers ----------

function sheet_() {
  return SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
}

function allRows_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues().map((v, i) => ({
    row: i + 2, ts: v[COL.TS - 1], no: v[COL.NO - 1], name: v[COL.NAME - 1], service: v[COL.SERVICE - 1],
    status: v[COL.STATUS - 1], uid: v[COL.UID - 1], stylist: v[COL.STYLIST - 1], visit: v[COL.VISIT - 1],
  }));
}

function todayRows_() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return allRows_().filter(r => r.ts instanceof Date && Utilities.formatDate(r.ts, TZ, 'yyyy-MM-dd') === today);
}

/** ตรวจ ID token กับ LINE แล้วคืน userId จริง (กันการปลอม userId) */
function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('missing idToken');
  const clientId = PropertiesService.getScriptProperties().getProperty('LOGIN_CHANNEL_ID');
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: clientId },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('LINE login หมดอายุ กรุณาเปิดหน้าใหม่');
  return JSON.parse(res.getContentText()).sub;
}

function push_(userId, text) {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) console.error('push failed', res.getResponseCode(), res.getContentText());
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
