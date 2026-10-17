# Million Hair Studio — LINE Booking

ต้นแบบระบบจองคิวทำผมผ่าน LINE (โครงงาน Digital Transformation · ร้านสมมติ)

- `docs/index.html` — LIFF app ลูกค้า: จอง 5 ขั้น (บริการ → ช่าง → วัน-เวลา → รายละเอียด → ยืนยัน/มัดจำ), นัดของฉัน (เลื่อน/ยกเลิก/ลงปฏิทิน/จองซ้ำ), ราคา, ช่าง, Lookbook
- `docs/admin/` — หลังบ้าน: ตารางนัดรายช่าง, เปลี่ยนสถานะ, ตรวจสลิป, เพิ่มนัด Walk-in/โทรจอง, รายงาน + CSV/PDF
- `apps-script/Code.gs` — backend บน Google Apps Script + Google Sheets (แท็บ Bookings), Flex message, แจ้งเตือนก่อนวันนัด, rich menu
- `docs/assets/` — โลโก้และรูป rich menu · `richmenu/brand.html` คือไฟล์ต้นฉบับที่ใช้ render
- `docs/vendor/qrcode-2.0.4.js` — qrcode-generator (MIT, Kazuhiko Arase) สำหรับ QR PromptPay

ไม่มี secret ใน repo — token, Channel ID, Admin IDs และ PromptPay ID เก็บใน Script Properties ของ Apps Script เท่านั้น
