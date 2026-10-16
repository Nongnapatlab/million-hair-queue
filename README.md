# Million Hair — Virtual Queue

ต้นแบบระบบคิวเสมือนสำหรับร้านทำผม (โครงงาน Digital Transformation)

- `docs/index.html` — หน้า LIFF ลงคิว (โฮสต์บน GitHub Pages)
- `apps-script/Code.gs` — backend บน Google Apps Script ผูกกับ Google Sheets

Flow: ลูกค้าสแกน QR → LIFF ลงคิว → Apps Script บันทึกลง Sheets → พนักงานเปลี่ยนสถานะเป็น "ใกล้ถึงคิว" → Push แจ้งเตือนผ่าน LINE

ไม่มี secret ใน repo นี้ — Channel access token และ Login Channel ID เก็บใน Script Properties ของ Apps Script เท่านั้น
