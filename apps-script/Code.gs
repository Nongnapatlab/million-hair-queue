/**
 * Million Hair — Virtual Queue backend (Google Apps Script, bound to the Google Sheet)
 *
 * Script Properties (Project Settings → Script properties):
 *   LINE_TOKEN        Channel access token (long-lived) ของ Messaging API channel
 *   LOGIN_CHANNEL_ID  Channel ID ของ LINE Login channel (MillionHair Queue App)
 *
 * ครั้งแรก: รัน setup() 1 ครั้งจาก editor (สร้างหัวตาราง, Dropdown, trigger)
 */

const SHEET_NAME = 'Queue';
const CHAIRS = 2;
const SERVICES = { // นาทีโดยประมาณต่อบริการ ใช้คำนวณเวลารอ
  'ตัดผม': 30,
  'สระ-ไดร์': 30,
  'ตัด + สระ-ไดร์': 45,
  'ทำสี': 90,
};
const STATUS = {
  WAITING: 'รอคิว',
  NEAR: 'ใกล้ถึงคิว',
  SERVING: 'รับบริการ',
  DONE: 'เสร็จสิ้น',
  NO_SHOW: 'ไม่มา',
};
const HEADERS = ['Timestamp', 'Queue No', 'Name', 'Service', 'Status', 'LINE User ID',
  'Called At', 'Started At', 'Finished At', 'Channel'];
const COL = { TS: 1, NO: 2, NAME: 3, SERVICE: 4, STATUS: 5, UID: 6, CALLED: 7, STARTED: 8, FINISHED: 9, CHANNEL: 10 };
const TZ = 'Asia/Bangkok';

// ---------- setup ----------

function setup() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.hideColumns(COL.UID);

  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.values(STATUS), true).setAllowInvalid(false).build();
  sh.getRange(2, COL.STATUS, sh.getMaxRows() - 1, 1).setDataValidation(statusRule);
  const channelRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['LINE', 'Walk-in'], true).build();
  sh.getRange(2, COL.CHANNEL, sh.getMaxRows() - 1, 1).setDataValidation(channelRule);
  sh.getRange(2, COL.SERVICE, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(SERVICES), true).build());

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onStatusEdit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(ss).onEdit().create();
}

// ---------- Web App (LIFF → Sheets) ----------

function doGet(e) {
  const action = (e.parameter.action || '').toLowerCase();
  if (action === 'services') return json_({ ok: true, services: Object.keys(SERVICES) });
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
  const service = String(body.service || '');
  if (!name) throw new Error('กรุณากรอกชื่อ');
  if (!SERVICES[service]) throw new Error('บริการไม่ถูกต้อง');
  if (body.consent !== true) throw new Error('ต้องยินยอมให้เก็บข้อมูลก่อนลงคิว');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const existing = statusOf_(userId);
    if (existing.inQueue) return existing; // กันลงคิวซ้ำ

    const sh = sheet_();
    const now = new Date();
    const queueNo = todayRows_().length + 1;
    sh.appendRow([now, queueNo, name, service, STATUS.WAITING, userId, '', '', '', 'LINE']);
  } finally {
    lock.releaseLock();
  }
  return statusOf_(userId);
}

/** สถานะคิวของ user วันนี้ + จำนวนคิวก่อนหน้า + เวลารอโดยประมาณ (นาที) */
function statusOf_(userId) {
  const rows = todayRows_();
  const active = [STATUS.WAITING, STATUS.NEAR];
  const mine = rows.find(r => r.uid === userId && (active.includes(r.status) || r.status === STATUS.SERVING));
  if (!mine) return { ok: true, inQueue: false };

  if (mine.status === STATUS.SERVING) {
    return { ok: true, inQueue: true, queueNo: mine.no, status: mine.status, ahead: 0, waitMin: 0 };
  }
  const ahead = rows.filter(r => r.row < mine.row && active.includes(r.status));
  const serving = rows.filter(r => r.status === STATUS.SERVING);
  const minutes = ahead.reduce((s, r) => s + (SERVICES[r.service] || 30), 0)
    + serving.reduce((s, r) => s + (SERVICES[r.service] || 30) / 2, 0); // คนที่กำลังทำ คิดว่าเหลือครึ่งเวลา
  return {
    ok: true, inQueue: true, queueNo: mine.no, status: mine.status,
    ahead: ahead.length, waitMin: Math.round(minutes / CHAIRS),
  };
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
    const [no, name, uid] = [
      sh.getRange(row, COL.NO).getValue(),
      sh.getRange(row, COL.NAME).getValue(),
      sh.getRange(row, COL.UID).getValue(),
    ];
    if (uid) {
      push_(uid, `✂️ คุณ${name} ใกล้ถึงคิวแล้ว (คิวที่ ${no})\nกรุณากลับมาที่ร้าน Million Hair ภายใน 10 นาทีนะคะ`);
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

function todayRows_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues()
    .map((v, i) => ({ row: i + 2, ts: v[0], no: v[1], service: v[3], status: v[4], uid: v[5] }))
    .filter(r => r.ts instanceof Date && Utilities.formatDate(r.ts, TZ, 'yyyy-MM-dd') === today);
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
