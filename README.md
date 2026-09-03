# นามิ (Nami)

> เตือน · เก็บไฟล์ · จัดการ ภายในแชทเดียว ไม่ต้องโหลดแอปเพิ่ม

LINE Official Account ที่ทำหน้าที่เป็นผู้ช่วยส่วนตัว ใช้ได้ทั้งแชท 1:1 และแชทกลุ่ม
คุยด้วยภาษาไทยธรรมชาติ ไม่มี command syntax

---

## สถานะการพัฒนา

| Phase | ขอบเขต | สถานะ |
|-------|--------|-------|
| **P1** | webhook + signature verify + echo + docker compose | ✅ เสร็จ |
| **P1.5** | ชั้น LLM (OpenRouter) + บันทึกต้นทุน USD จริง | ✅ เสร็จ |
| **P2** | NLU + ตั้งเตือนรายครั้ง + Flex ยืนยัน | ✅ เสร็จ |
| **P3** | scheduler + เตือนซ้ำ + postback แก้/ยกเลิก | ✅ เสร็จ |
| **P4** | vault เก็บ + ค้นหา | ✅ เสร็จ |
| **P5** | โหมดกลุ่ม + mention | ✅ เสร็จ |
| **P6** | rich menu + ขัดเกลาข้อความ + test | ✅ เสร็จ |
| **P6+** | ตั้งเตือนจากรูป (feature 3 — เดิมอยู่ใน deliverables ตั้งแต่แรกแต่ตกหล่นไปจนถึงตอนนี้) | ✅ เสร็จ |

---

## เริ่มใช้งานใน 5 ขั้น

### 1. ติดตั้ง dependency

```bash
npm install
```

> ถ้า npm เตือนเรื่อง install script ให้รัน `npm approve-scripts prisma @prisma/client @prisma/engines esbuild fsevents`
> (Prisma ต้องใช้ postinstall เพื่อดาวน์โหลด query engine, esbuild ต้องใช้เพื่อคอมไพล์ TypeScript)

### 2. ตั้งค่า env

```bash
cp .env.example .env
```

แล้วเติม 3 ค่านี้เป็นอย่างน้อย:

```
LINE_CHANNEL_SECRET=...        # ดู "ตั้งค่า LINE OA" ด้านล่าง
LINE_CHANNEL_ACCESS_TOKEN=...
OPENROUTER_API_KEY=...         # https://openrouter.ai/settings/keys
```

> **ตั้ง spend limit ให้ OpenRouter key ด้วย** ที่ https://openrouter.ai/settings/limits
> key ที่ไม่มี limit ถ้ารั่วจะถูกใช้ได้ไม่จำกัด — `/debug/llm-config` จะเตือนถ้ายังไม่ตั้ง

### 3. ยก infra ขึ้น (Postgres + Redis + MinIO)

```bash
docker compose up -d
```

| service | host port | หมายเหตุ |
|---------|-----------|----------|
| postgres (pgvector/pg16) | `55432` | ใช้ 55432 ไม่ใช่ 5432 เพราะพอร์ตมาตรฐานมักชนกับ Postgres ตัวอื่นบนเครื่อง |
| redis | `6379` | ตั้ง `maxmemory-policy noeviction` ตามที่ BullMQ ต้องการ |
| minio | `9000` (API) / `9001` (console) | เข้า console ด้วย `nami-minio` / `nami-minio-secret` |

`minio-init` จะสร้าง bucket `nami-vault` ให้อัตโนมัติแล้วจบตัวเอง

### 4. รัน migration

```bash
npx prisma migrate deploy
npx prisma generate
```

### 5. รันแอป (ต้องเปิด 2 terminal)

```bash
npm run dev          # API รับ webhook — พอร์ต 3100
```

```bash
npm run dev:worker   # worker ประมวลผล event
```

> **ทำไมต้องแยก 2 process?**
> LINE ต้องได้ HTTP 200 ภายใน ~1 วินาที ถ้าให้งานหนัก (เรียก LLM, ดาวน์โหลดไฟล์) รันใน request cycle
> เดียวกันจะตอบไม่ทันแล้ว LINE จะ retry ซ้ำๆ
> `src/index.ts` แค่ verify signature → enqueue → ตอบ 200 ส่วน `src/worker/index.ts` ทำงานจริงทีหลัง

---

## ตั้งค่า LINE OA

### 5.1 สร้าง channel

1. เข้า [LINE Developers Console](https://developers.line.biz/console/) → สร้าง **Provider** (ถ้ายังไม่มี)
2. สร้าง channel ชนิด **Messaging API**
3. แท็บ **Basic settings** → คัดลอก **Channel secret** → ใส่ `LINE_CHANNEL_SECRET`
4. แท็บ **Messaging API** → เลื่อนลงหา **Channel access token (long-lived)** → กด **Issue** → คัดลอกใส่ `LINE_CHANNEL_ACCESS_TOKEN`

### 5.2 เปิด ngrok ให้ LINE ยิงเข้าเครื่องเราได้

```bash
ngrok http 3100
```

จะได้ URL หน้าตาแบบ `https://xxxx-xx-xx.ngrok-free.app`

> ngrok ฟรีจะเปลี่ยน URL ทุกครั้งที่รีสตาร์ท ต้องกลับไปแก้ Webhook URL ใน console ใหม่ทุกครั้ง

### 5.3 ตั้ง Webhook URL

ที่ LINE Developers Console → แท็บ **Messaging API**:

1. **Webhook URL** = `https://xxxx-xx-xx.ngrok-free.app/webhook` (อย่าลืม `/webhook` ต่อท้าย)
2. เปิด **Use webhook**
3. กด **Verify** — ต้องขึ้น Success

### 5.4 ตั้งค่าที่ LINE OA Manager (ข้อนี้ข้ามไม่ได้)

เข้า [LINE OA Manager](https://manager.line.biz/) → เลือกบัญชี → **การตั้งค่า**

| ตำแหน่ง | ต้องตั้งเป็น | ทำไม |
|---------|-------------|------|
| การตอบกลับ → **การตอบกลับอัตโนมัติ** | **ปิด** | ถ้าเปิด LINE จะตอบข้อความสำเร็จรูปทับข้อความของนามิ |
| การตอบกลับ → **ข้อความต้อนรับ** | ปิด (ถ้าไม่ต้องการ) | นามิมีข้อความต้อนรับของตัวเองอยู่แล้ว |
| การตอบกลับ → **Webhook** | **เปิด** | ไม่เปิด = event ไม่ถูกส่งมาที่เราเลย |
| บัญชี → **อนุญาตให้บอทเข้าร่วมแชทกลุ่ม** | **เปิด** | จำเป็นสำหรับฟีเจอร์ผู้ช่วยประจำกลุ่ม |

### 5.5 ตรวจว่าตั้งถูกไหม

รันแอปแล้วเปิด:

```bash
curl -s localhost:3100/debug/line-config | jq
```

endpoint นี้จะ:
- เรียก `getBotInfo` เพื่อเช็คว่า access token ใช้ได้จริง และ `chatMode` เป็น `bot`
- เรียก `getWebhookEndpoint` + `testWebhookEndpoint` เพื่อเช็คว่า LINE ยิงเข้ามาถึงเราได้
- คืน `problems[]` เป็นภาษาไทยบอกว่าต้องไปแก้อะไรที่ไหน
- คืน `manualChecklist[]` สำหรับข้อที่ API เช็คแทนไม่ได้

> เปิดใช้ได้เฉพาะเมื่อ `NODE_ENV !== production` (มันเปิดเผยสถานะการตั้งค่า)

---

## ชั้น LLM (OpenRouter)

ใช้ **OpenRouter** เจ้าเดียวทั้ง NLU, อ่านรูป และ embeddings เรียกผ่าน `openai` SDK ที่ชี้ `baseURL`
ไปที่มัน (OpenRouter พูดภาษาเดียวกับ OpenAI API) ถ้าจะย้าย provider ทีหลังแก้ที่ `src/llm/client.ts` ไฟล์เดียว

### ทำไมต้องใช้ 2 โมเดล

วัดผลจริงด้วย `npm run llm:bench` และการอ่านรูปเอกสารไทย:

| งาน | โมเดล | ผล | ราคา |
|---|---|---|---|
| NLU ข้อความไทย | `google/gemini-2.5-flash-lite` | 6/6 | ~$0.00005/ครั้ง |
| ใบนัดหมอ (แปลง พ.ศ. → ค.ศ., แยก 2 นัด) | flash-lite | ✅ | ~$0.0003/รูป |
| **ตารางเวร (หลายคอลัมน์)** | flash-lite | ❌ **อ่านข้ามคอลัมน์** | |
| ตารางเวรตัวเดียวกัน | `google/gemini-2.5-flash` | ✅ 4/4 | ~$0.0015/รูป |

จึงตั้งเป็น 2 ตัวแยกกัน (`LLM_MODEL_TEXT` / `LLM_MODEL_VISION`) — **อย่ารวมเป็นตัวเดียวเพื่อประหยัด**
ถ้าจะเปลี่ยนโมเดล ให้รัน `npm run llm:bench -- <model-id>` เทียบก่อนเสมอ

โมเดล `:free` ใช้ไม่ได้: `minimax/minimax-m3:free` ไม่เคารพ `json_schema` (ห่อ ```json, ทิ้ง field ที่บังคับ),
`google/gemma-4-31b-it:free` ตอบ HTTP 429 ทันที

### กฎการเรียก LLM

`completeStructured()` ใน `src/llm/chat.ts` เป็นทางเดียวที่อนุญาตให้เรียกโมเดล มันการันตี 3 อย่าง:

1. **ไม่ throw** — คืน discriminated union `{ ok: true, data }` หรือ `{ ok: false, reason, detail }`
2. **ไม่เดา** — output ต้องผ่าน zod เท่านั้น ถ้าไม่ผ่านคืน `ok: false` ให้ผู้เรียกไปถามผู้ใช้กลับ
3. **บันทึกต้นทุนเสมอ** — รวมตอนที่ผลลัพธ์ใช้ไม่ได้ เพราะเราจ่ายเงินไปแล้วจริง

มี repair pass 1 ครั้ง (ส่ง error กลับไปให้โมเดลแก้) เกินกว่านั้นไม่คุ้มทั้งเวลาและเงิน
`api_error` ไม่ repair — ปล่อยให้ BullMQ retry ชั้นนอกจัดการ

zod schema ที่ส่งเข้า `completeStructured` ต้องใช้ `.nullable()` ไม่ใช่ `.optional()`
เพราะ strict mode บังคับว่าทุก property ต้องอยู่ใน `required` (`toStrictJsonSchema` แปลงให้อัตโนมัติ)

### ต้นทุนจริง ไม่ใช่ค่าประมาณ

OpenRouter แนบ `usage.cost` (USD ของ request นั้น) มาทุกครั้ง เราเก็บลง
`usage_counters.llm_cost_usd` เป็น `DECIMAL(14,8)` → ไม่ต้องเดาราคาจากตารางราคาเอง
ซึ่งสำคัญเพราะเราสลับโมเดลตาม tier และราคาต่อโมเดลเปลี่ยนได้

### ตรวจการตั้งค่า

```bash
curl -s localhost:3100/debug/llm-config | jq          # ไม่เสียเงิน
curl -s 'localhost:3100/debug/llm-config?probe=1' | jq  # ยิงจริง เสียเงินหลักเศษสตางค์
```

เช็คให้: key ใช้ได้ไหม, เครดิต/spend limit, โมเดลที่ตั้งไว้มีจริงไหม (สะกดผิดคือสาเหตุพังที่พบบ่อยสุด),
และ **โมเดล vision รับ input เป็นรูปได้จริงไหม**

---

## Scheduler: ทน restart และไม่ยิงซ้ำ

### สองทางเข้าหา occurrence เดียวกัน

```
occurrence (pending)
   ├─ delayed job ของ BullMQ   แม่นระดับวินาที ไม่ต้องโพลล์ แต่หายได้
   └─ cron sweeper ทุก 1 นาที   ช้ากว่า แต่ไม่หาย
        ↓ ทั้งสองใช้ jobId = occurrence id เดียวกัน
   fireOccurrence()  claim ได้แค่ตัวเดียว
```

BullMQ ปฏิเสธ job ที่ `jobId` ซ้ำเงียบๆ จึงไม่มีทางได้สอง job ต่อ occurrence
และแม้จะหลุดมาสองตัว `fireOccurrence()` ก็ claim ได้แค่ตัวเดียว

### ลำดับที่ทำให้ไม่ยิงซ้ำและไม่ยิงหาย

```
pending  ──claim──▶  sending  ──push ok──▶  sent
                        │
                        ├── push พลาด (ยัง retry ได้) ──▶ pending
                        ├── push พลาด (ครบ 3 ครั้ง)   ──▶ failed
                        └── process ตาย → sweeper พากลับ ──▶ pending
```

การ claim คือ `UPDATE ... WHERE id = ? AND status = 'pending'` แบบ atomic
Postgres ล็อกแถวให้เองระหว่าง UPDATE ถ้าได้ 0 แถว = มีคนอื่นจับไปแล้ว → ออกเงียบๆ

**ทำไมไม่ push ก่อนแล้วค่อย mark sent:** ถ้าตายระหว่างนั้นจะยิงซ้ำ เสียเงินและกวนผู้ใช้
**ทำไมไม่ mark sent ก่อน push:** ถ้าตายระหว่างนั้นการเตือนหายเงียบ กู้ไม่ได้
สถานะ `sending` คือคำตอบ — `recoverStuckOccurrences()` พาแถวที่ค้างเกิน 5 นาทีกลับมา

ยืนยันด้วยเทสต์: ยิง occurrence เดียวกันพร้อมกัน 5 ตัว → `push` ถูกเรียก **ครั้งเดียว**

### เวลาซ้ำที่ไม่เพี้ยนสะสม

occurrence เก็บเวลา 2 ค่า:

| คอลัมน์ | คืออะไร |
|---|---|
| `fire_at_utc` | เวลาที่ยิงจริง (ถูกเลื่อนแล้วถ้าตกในช่วงเงียบ) |
| `canonical_fire_at_utc` | เวลาตามตารางเดิมก่อนเลื่อน |

รอบถัดไปคำนวณจาก **canonical** ไม่ใช่เวลาที่ยิงจริง
ถ้าไม่แยกเก็บ: เตือนทุกวัน 23:00 ที่ถูกเลื่อนไป 07:00 จะทำให้รอบถัดไปนับจาก 07:00
แล้วตารางค่อยๆ ไหลออกจากที่ผู้ใช้ตั้งไว้ทุกวัน

### rrule กับ timezone

`rrule` ทำงานบน UTC/floating time แต่การเตือนผูกกับ **เวลาท้องถิ่นของผู้ใช้**
ถ้าคำนวณบน UTC ตรงๆ จะเพี้ยนทันทีที่ผู้ใช้อยู่ tz ที่มี DST จึงใช้ floating date trick:

1. ใช้ rrule หาแค่ "วันไหน" โดยมองวันเป็น UTC midnight (ไร้ timezone)
2. ได้วันแล้วค่อยแปะเวลาในโซนของผู้ใช้ด้วย `atLocalMinute()`
3. แปลงเป็น UTC ตอนท้ายสุด

**ห้ามใช้ `startOf('day').plus({ minutes })`** — `plus` บวก *ระยะเวลาจริง*
วันที่มี DST มี 23 หรือ 25 ชั่วโมง ทำให้ผลเพี้ยนไป 1 ชั่วโมง
(เจอจริง: 1 พ.ย. 2026 ที่นิวยอร์ก `00:00 + 480 นาที` = **07:00** ไม่ใช่ 08:00)
`atLocalMinute()` ใช้ `set()` ที่ยึดหน้าปัดนาฬิกา จึงได้ 08:00 เสมอ

### สิ่งที่ทดสอบไว้

รายเดือนวันที่ 31 → **ข้าม** เดือนที่ไม่มีวันที่ 31 (ไม่ใช่เลื่อนไปวันที่ 1) ·
29 ก.พ. → เจอแค่ปีอธิกสุรทิน · `BYMONTHDAY=-1` → วันสุดท้ายจริงของแต่ละเดือน ·
DST ทั้ง spring forward และ fall back · quiet hours ที่ข้ามเที่ยงคืน

---

## NLU: ทำไมต้องมีตัวตรวจทานเป็นโค้ด

โมเดลอ่านภาษาไทยเก่ง แต่**พลาดตรงส่วนที่คำนวณได้แน่นอน** และพลาดซ้ำเดิมทุกรอบ (ทดสอบ 3 รอบ ผลเหมือนกันหมด):

| ผู้ใช้พิมพ์ | โมเดลให้ | ที่ถูก |
|---|---|---|
| "เตือนวันศุกร์ 2 ทุ่ม ดูหนังกับแฟน" | **เสาร์ 5 ก.ย. 19:00** ❌ | ศุกร์ 4 ก.ย. 20:00 |
| "เตือน 3 ทุ่มครึ่ง อ่านหนังสือ" | พฤหัส 21:30 ✅ | ถูกอยู่แล้ว |
| "เตือนวันจันทร์ 5 โมงเย็น ส่งของ" | `FREQ=WEEKLY;BYDAY=MO` ❌ | เตือนครั้งเดียว |
| "ทุกวันจันทร์-ศุกร์ 8 โมง" | `fireAtMinuteLocal = 8` ❌ | 480 |
| "ทุกวัน 23.00 เตือนกินยา" | `fireAtMinuteLocal = 23` ❌ | 1380 |

prompt แก้ไม่หาย เพราะเป็นการคำนวณ ไม่ใช่ความเข้าใจภาษา
แต่คำบอกเวลาไทยเป็น **เซตปิด** จึงเขียนโค้ดคำนวณเองได้ → `src/nlu/thaiTime.ts`

โครงสร้างจึงเป็น **"ให้โมเดลทำภาษา เราทำเลข"**:

```
ข้อความไทย
  → LLM        จับเจตนา, แยก title ออกจากวลีบอกเวลา, บอกว่าอะไรกำกวม
  → resolveDueAt  แปลงเป็น UTC + กฎ "เวลาผ่านไปแล้วทำยังไง"   (deterministic)
  → verifyDueAt   ตรวจทาน "2 ทุ่ม"/"วันศุกร์" ทับผลโมเดลถ้าไม่ตรง  (deterministic)
  → บันทึก
```

`verifyDueAt` แก้เฉพาะเมื่อมั่นใจ และ **log ทุกครั้งที่แก้** เพื่อวัดว่าโมเดลพลาดบ่อยแค่ไหน
จากการทดสอบจริง 7 ข้อความ มันแก้ 2 ครั้ง (~29%)

การเตือนซ้ำก็ใช้หลักเดียวกัน: `resolveFireMinute()` คำนวณ `fireAtMinuteLocal` เอง
เพราะโมเดลส่ง **ชั่วโมง** มาแทน **นาทีจากเที่ยงคืน** ซ้ำทุกรอบ
(`"8 โมง"` → `8` ไม่ใช่ `480` ทำให้การเตือนไปตกตอน 00:08 แล้วถูกเลื่อนเพราะช่วงเวลาเงียบ
ผู้ใช้จะไม่เข้าใจเลยว่าทำไม)

รองรับคำบอกเวลาไทย: `18.00` `18:30 น.` `20 นาฬิกา` · `ตี 1-5` · `N โมงเช้า` ·
`เที่ยง` `เที่ยงคืน` · `บ่ายโมง` `บ่าย N` · `N โมงเย็น` · `N ทุ่ม` · `ครึ่ง` ·
เลขไทยเป็นคำ (`สองทุ่ม`) และเลขไทย (`๒ ทุ่ม`)

### กฎ "ซ้ำ" ต้องมีตัวบอกความซ้ำ

ภาษาไทยต่างกันชัดเจน แต่โมเดลแยกไม่ออก:

- `"ทุกวันจันทร์ 8 โมง"` → เตือนซ้ำ
- `"วันจันทร์ 8 โมง"` → **เตือนครั้งเดียว** (จันทร์ที่จะถึง)

`looksRecurring()` บังคับกฎนี้ในโค้ด ถ้าโมเดลบอกว่าซ้ำแต่ข้อความไม่มี `ทุก`/`ประจำ`/`ซ้ำ`
หรือช่วงวันแบบ `จันทร์-ศุกร์` → ถือว่าครั้งเดียว
(ถ้าไม่มีกฎนี้ ผู้ใช้จะถูกปฏิเสธทั้งที่ตั้งเตือนครั้งเดียวได้)

`sanitizeNluResult()` เก็บกวาดอีกกรณี: `"ทุก 30 นาที เตือนพักสายตา"`
โมเดลใส่ `ambiguousFields = ["time"]` ทั้งที่การเตือนแบบทุก N นาทีไม่มีเวลาของวันให้ระบุ
ถ้าไม่กรองออก นามิจะถามว่า "กี่โมงดี" ซึ่งเป็นคำถามที่ตอบไม่ได้

### ถามกลับเมื่อไหร่

ใช้ **2 สัญญาณ** ไม่ใช่แค่ `confidence`:

1. `ambiguousFields` ที่โมเดลระบุมาตรงๆ — สัญญาณหลัก
2. `confidence < NLU_CONFIDENCE_THRESHOLD` — สัญญาณสำรอง

เพราะ `confidence` ไม่เสถียร: ข้อความกำกวมเดียวกัน (`"เตือนตอนเย็นๆ นะ"`) รอบหนึ่งได้ 0.5 อีกรอบได้ 0.7
ถ้าพึ่งตัวเลขเดียว จะปล่อยของกำกวมผ่านแล้วเดาเวลาให้ผู้ใช้เอง

### ambiguousFields เป็นเรื่องของการตั้งเตือนเท่านั้น

เจอจริง: `"เดี๋ยวส่งให้นะ https://... เอกสารสัญญา"` (intent = `save_to_vault`) โมเดลใส่
`ambiguousFields = ["time"]` มาด้วย ทั้งที่ `save_to_vault` ไม่มีแนวคิดเรื่องเวลาเลย —
ถ้าไม่กรองออก นามิจะถามว่า "กี่โมงดี" ทั้งที่ผู้ใช้แค่ขอให้เก็บลิงก์ไว้

`sanitizeNluResult()` จึงตัด `ambiguousFields` ทิ้งทั้งหมดเมื่อ `intent !== 'create_reminder'`
เพราะ field ทั้ง 5 ตัว (`time`/`date`/`title`/`recurrence`/`assignee`) มีความหมายเฉพาะตอนตั้งเตือนเท่านั้น

---

## Vault: เก็บของไม่มีวันหมดอายุ + ค้นหาแบบ hybrid

### เก็บอะไรได้บ้าง และเก็บยังไง

| ผู้ใช้ทำ | นามิเก็บอะไร |
|---|---|
| ส่งข้อความที่มีลิงก์ (ไม่ว่าเรียกนามิหรือไม่) | เก็บลิงก์แบบเงียบๆ ทันที ไม่ตอบกลับ |
| พิมพ์ "จำไว้ด้วยว่า..." / "เก็บไว้ให้ด้วย" | เก็บข้อความทั้งประโยคเป็น `kind: text` |
| ส่งรูป/ไฟล์ | ดาวน์โหลดจาก LINE ทันที (ไฟล์ใน LINE มีอายุจำกัด) แล้วอัปโหลดเก็บถาวรใน MinIO/R2 |

**การจับลิงก์ไม่ผ่าน LLM** (`src/vault/urls.ts`) — เป็น regex ล้วน เร็วกว่าและแม่นกว่า
การเรียกโมเดลมาทำเรื่องที่เป็นรูปแบบตายตัว

**ในกลุ่ม**: เก็บลิงก์/ไฟล์แบบเงียบๆ แม้ไม่ได้ถูกเรียก (vault ของกลุ่มต้องมีของที่ทุกคนส่งไว้)
แต่ตอบกลับเฉพาะแชท 1:1 เพื่อไม่ให้กลายเป็นบอทสแปมในกลุ่ม — เหมือนกติกาอื่นในกลุ่ม

### โควตาพื้นที่เก็บ: สะสมตลอดกาล ไม่ใช่รายเดือน

`usage_counters` (จาก P1) คีย์ด้วย `(scope, month)` เหมาะกับต้นทุนที่เกิดใหม่ทุกเดือน
(push, LLM) แต่ vault **"ไม่มีวันหมดอายุ"** — ไฟล์เดือนที่แล้วยังกินพื้นที่อยู่
จึงคำนวณโควตาจาก `SUM(vault_items.size_bytes)` ตรงๆ (`src/vault/quota.ts`) ไม่ใช้ตาราง usage_counters
(ตารางนั้นยังใช้บันทึกต้นทุน storage รายเดือนไว้ดูแนวโน้ม แต่ไม่ใช้ตัดสินโควตา)

### ลำดับที่กันของหายและกันของเปิดไม่ได้

```
เช็คโควตา (ก่อนดาวน์โหลด — พื้นที่เต็มไม่ต้องเสียเวลาโหลด)
   │
   ├─ ดาวน์โหลดจาก LINE พลาด → ไม่สร้างแถวใน DB เลย
   │
   ├─ อัปโหลดขึ้น storage พลาด → ไม่สร้างแถวใน DB เลย
   │                             (กันรายการที่มีอยู่แต่เปิดไฟล์ไม่ได้)
   │
   └─ สำเร็จ → สร้างแถว → บันทึกต้นทุน storage → เติม embedding (ถ้าเปิดใช้)
```

ไม่ insert ก่อน upload เพราะผู้ใช้ไม่ควรเห็นรายการที่ดาวน์โหลด/อัปโหลดไม่สำเร็จ
`attachEmbedding()` แยกเป็นขั้นตอนท้ายสุดและครอบ try/catch ของตัวเอง — ถ้า embedding พัง
(โควตา LLM หมด, API ล่ม) ไม่ควรทำให้การบันทึกไฟล์ล้มเหลวทั้งหมด full-text + trgm ยังค้นได้อยู่

### hybrid search: 3 ชั้นที่ต้องผสมกัน

เหมือนที่อธิบายไว้ตอน P1 — ภาษาไทยไม่เว้นวรรค `to_tsvector('simple', ...)` จึงจับได้ดี
แค่คำอังกฤษ/ชื่อไฟล์ ส่วนคำไทยต้องพึ่ง `pg_trgm` + `pgvector`

**บั๊กที่เจอตอน e2e จริง (ไม่ใช่ unit test):** ใช้ `similarity()` เทียบ "ทั้งสตริง" กับ
"ทั้งสตริง" ตอนแรก — คำค้นสั้นๆ ("สัญญา") ในเอกสารที่ยาวกว่า 50 ตัวอักษร ได้คะแนนแค่ 0.07
เพราะ `similarity()` ถูกเจือจางด้วยส่วนที่ไม่ตรงกันของสตริงยาว ทำให้ **ต่ำกว่า threshold ทุกกรณี
และค้นหาไม่เจออะไรเลยทั้งที่ข้อมูลมีอยู่จริง** หน่วยทดสอบผ่านหมด (เพราะข้อความในเทสต์สั้น)
แต่พังตอนรันจริงกับข้อความยาวแบบที่คนพิมพ์จริง

แก้ด้วย `word_similarity(query, doc)` แทน — หา substring ที่ตรงที่สุดใน doc ให้ query สั้นๆ
โดยไม่เจือจางตามความยาวของ doc (ได้ 0.6-0.8 สำหรับกรณีเดียวกัน) โดยที่คำไม่เกี่ยวข้องยังคงคะแนนต่ำ
เหมือนเดิม (ไม่เพิ่ม false positive)

คะแนนรวม: `ts_rank * 2.0 + word_similarity * 1.0 + cosine_similarity * 3.0`
ให้น้ำหนัก semantic มากสุดเพราะเข้าใจความหมายกว้างสุด, trgm น้อยสุดเพราะ match substring
สั้นๆ ได้ง่ายจนเป็น noise ถ้าไม่คุมน้ำหนัก

### ทดสอบตำแหน่ง placeholder ให้ถูกต้องเสมอ

query ประกอบ SQL string เอง (`$queryRawUnsafe`) เพราะ pgvector literal ต้องส่งเป็น string
ผ่าน raw query — ตำแหน่ง `$1, $2, ...` **คำนวณจากตำแหน่งจริงใน params array** ไม่ hardcode เลข
เพราะเคย hardcode ผิดตอนที่ไม่มี `kind` filter (ตัว vector เลื่อนตำแหน่งไปชนกับ placeholder เดิม)

### ส่งไฟล์กลับ

ไม่เก็บ URL ถาวรไว้ใน DB — ขอ **signed URL ชั่วคราว** (`getSignedDownloadUrl`, หมดอายุ 10 นาที)
ตอนกดปุ่ม "ส่งไฟล์/รูปกลับมา" เท่านั้น เพราะ credential เปลี่ยนได้และ URL ควรหมดอายุเพื่อความปลอดภัย
รูปส่งกลับเป็น LINE image message ตรงๆ ส่วนไฟล์ทั่วไป (LINE ไม่มี message type สำหรับไฟล์)
ส่งเป็นข้อความลิงก์เปิด/ดาวน์โหลดแทน

---

## ตั้งเตือนจากรูป (feature 3)

ส่งรูปใบนัดหมอ/ตารางเรียน/ตารางเวรมาให้นามิ — อ่านด้วย vision แล้วเสนอรายการเตือนให้ยืนยันก่อนบันทึก
ทำงานควบคู่กับ vault (P4): รูปถูกเก็บเข้า vault เหมือนเดิมเสมอ ไม่ว่าจะตั้งเตือนจากรูปได้หรือไม่

```
รูป → saveMediaItem (เก็บ vault เหมือน P4)
    → parseImageForReminders (vision, tier: 'vision')
    → resolveImageItem ต่อรายการ (ตรวจทานเวลาแบบ deterministic — ห้ามเชื่อโมเดลเรื่องเลข)
    → createReminderDraft (บันทึกไว้รอยืนยัน หมดอายุใน 1 ชม.)
    → imageReminderReview Flex → ผู้ใช้กด [ยืนยันทั้งหมด] หรือ [ไม่ต้อง]
    → confirmReminderDraft (claim แบบ atomic เหมือน fire.ts) → สร้างเตือนจริงทีละรายการ
```

### หลักการเดียวกับ NLU ข้อความ: ให้โมเดลทำภาษา เราทำเลข

ประวัติทั้งโปรเจกต์พิสูจน์แล้วว่าโมเดลคำนวณตัวเลขเองพลาดซ้ำๆ (ดูหัวข้อ NLU) จึง**ห้ามให้โมเดล
คำนวณนาทีเอง** — สั่งให้คัดลอกเวลาที่เห็นในเอกสารมาเป็นข้อความ (`timeText`) แล้ว
`resolveImageItem()` คำนวณเองด้วย `extractClockMinute()` ฟังก์ชันเดียวกับที่ตรวจทานข้อความผู้ใช้
(ผ่านการทดสอบมาหนักแล้วตั้งแต่ P2)

**บั๊กที่เจอตอน e2e จริง (ไม่ใช่ unit test):** ทดสอบกับตารางเวรจริง โมเดลคัดลอกหัวคอลัมน์
`"เวรเช้า (07-15)"` มาทั้งช่วงเวลา ไม่ใช่เวลาจุดเดียว — `extractClockMinute()` ปฏิเสธถูกต้องแล้ว
(ออกแบบมาให้ปฏิเสธช่วงเวลาที่กำกวมในข้อความคุยกันทั่วไป) แต่สำหรับ**เอกสารตารางเวร ความหมายชัดเจน
อยู่แล้วว่าให้เตือนตอนเริ่มกะ** จึงเพิ่ม `extractRangeStart()` แยกไว้เฉพาะ path อ่านรูป
(ไม่แก้ `extractClockMinute` ที่ใช้ร่วมกับข้อความ เพราะจะกระทบกฎ "หลายเวลาขัดกัน → ไม่เดา")

ยืนยันด้วย `npm run image:probe` กับเอกสารทดสอบจริง 2 ชุด ผ่าน `parseImageForReminders()` ตัวจริง
(ไม่ใช่ mock): ใบนัดหมอ **2/2** ถูกต้อง (รวมแปลง พ.ศ. 2569 → ค.ศ. 2026), ตารางเวรพยาบาล 5 วัน
**15/15** ถูกต้องตรงกับตารางต้นฉบับทุกแถว หลังแก้บั๊กช่วงเวลาข้างต้น

### ทำไมต้องมี ReminderDraft (ไม่บันทึกตรงๆ)

วัดผลจริงตั้งแต่ P1.5 แล้วว่า vision **อ่านตารางหลายคอลัมน์พลาดได้** (โมเดลราคาถูกกว่าเคยอ่านสลับ
คอลัมน์ตารางเวร) ต่อให้เปลี่ยนมาใช้โมเดลที่แม่นกว่าแล้ว ก็ยังต้องให้ผู้ใช้เห็นก่อนว่านามิอ่านอะไรได้บ้าง
ตามสเปก — จึงเก็บเป็น draft (หมดอายุ 1 ชม.) แล้วให้ยืนยันทีเดียวทั้งชุด ไม่ใช่บันทึกตรงๆ

`confirmReminderDraft()` ใช้หลัก **claim แบบ atomic** เดียวกับ `fire.ts` (`UPDATE ... WHERE status='pending'`)
กันกดปุ่ม "ยืนยัน" ซ้ำสร้างเตือนซ้ำสอง — ทดสอบด้วยการยืนยันพร้อมกัน 5 ครั้ง ได้เตือนแค่ชุดเดียว

### ทดสอบ

```bash
npm run image:probe -- /path/to/appointment.png       # มีค่าใช้จ่ายจริง ~$0.001-0.004/รูป
```

---

## กลุ่ม + mention

### จับคู่ชื่อ → userId (`src/handlers/mentionResolve.ts`)

LINE ไม่ให้ list สมาชิกกลุ่ม (ถ้าไม่ใช่ verified OA) นามิจึงรู้จักได้แค่คนที่**เคยพูดในกลุ่มมาก่อน**
(เก็บไว้ใน `group_members` ตั้งแต่ P1 — ทุกครั้งที่มีคนพูด ไม่ว่าจะเรียกนามิหรือไม่)

เมื่อ NLU ดึงชื่อที่ถูกมอบหมายออกมาได้ (เช่น `"โบ๊ท"` จาก `"เตือนโบ๊ทพรุ่งนี้บ่าย 3 ส่งรายงาน"`)
`resolveAssignees()` จับคู่กับ `group_members` ตามกติกา **อนุรักษ์นิยม** (พลาดแล้วเงียบไว้ ดีกว่าเดา mention ผิดคน):

1. ตรงเป๊ะ (ตัดช่องว่าง/ตัวพิมพ์เล็กใหญ่) → ชนะทันที
2. ไม่เจอ → ลอง substring ทั้งสองทิศทาง (`"โบ๊ท"` ⊂ `"พี่โบ๊ท เก่งกาจ"`)
3. เจอมากกว่า 1 คนที่คะแนนเท่ากัน (ชื่อซ้ำในกลุ่ม, substring จับได้หลายคน) → **ไม่ resolve**

ชื่อที่จับคู่ไม่ได้ยังคงแสดงข้อความตามสเปก: *"ให้คนนั้นพิมพ์ในกลุ่มครั้งนึงก่อนนะ นามิจะจำไว้"*

### mention จริงเกิดตอนยิงเตือน ไม่ใช่ตอนตั้ง

Flex bubble **ไม่รองรับ mention จริง** (กดแล้วเด้งแจ้งเตือนหาคนนั้น) — ต่อให้พิมพ์ `"@ชื่อ"`
ลงในข้อความของ Flex ตรงๆ ก็เป็นแค่ตัวหนังสือเฉยๆ mention จริงรองรับเฉพาะข้อความ (`text`/`textV2`)
`src/line/mentionMessage.ts` จึงสร้าง **`textV2` แยกออกมาต่างหาก** (ใช้ `substitution` + placeholder
`{m0}`, `{m1}`, ...) ส่งคู่กับ Flex การ์ดรายละเอียด — ตอนตั้งเตือน (`reminderConfirm`) แค่โชว์ชื่อเป็น
ข้อความธรรมดา ไม่ต้อง ping ทันที เพราะจุดที่ควรเตือนจริงๆ คือตอนที่มันจะยิง ไม่ใช่ตอนบันทึก

### สมาชิกอาจออกจากกลุ่มไปแล้วตอนเตือนยิงจริง

`reminder.mention_user_ids` เก็บแค่ `userId` ไม่เก็บชื่อ — `fire.ts` **ดึงชื่อสดๆ จาก `group_members`
ตอนยิงจริง** ไม่ใช่ตอนสร้าง เผื่อชื่อเปลี่ยนหรือสมาชิกออกจากกลุ่มไปแล้ว (แถวใน `group_members` ไม่ถูกลบ
เมื่อออกจากกลุ่ม — ดูเหตุผลใน `lifecycle.ts`)

ถ้า mention target ใช้ไม่ได้แล้วจริง LINE จะปฏิเสธ**ทั้งชุดข้อความ** (ทั้ง mention และ Flex)
`fireOccurrence()` จึงมี fallback: push พร้อม mention ไม่สำเร็จ (`api_error`) → **ลองใหม่ทันทีแบบไม่มี mention**
เพื่อไม่ให้ปัญหาเรื่อง mention ทำให้การเตือนหลักส่งไม่ถึงผู้ใช้เลย

---

## Rich menu

### ตั้งเมนูครั้งแรก (หรือทุกครั้งที่แก้ผังปุ่ม)

```bash
npm run richmenu:setup
```

สคริปต์นี้ (`scripts/setup-richmenu.ts`) ทำ 4 อย่าง:

1. เรนเดอร์ `assets/richmenu/menu.html` เป็น PNG ขนาด **2500×1686** ด้วย headless Chrome —
   ใช้ Chrome แทนไลบรารีวาดภาพ (เช่น PIL) เพราะตัวเรนเดอร์ข้อความของแพลตฟอร์มจัดสระ/วรรณยุกต์ไทยผิดรูป
   ส่วน Chrome ใช้เอนจินเรนเดอร์เว็บจริงจึงจัดตัวอักษรไทยถูกต้อง (ปัญหานี้เจอมาแล้วตอนสร้างรูปทดสอบ vision ใน P2)
2. ลบ rich menu เก่าที่ชื่อ (`name`) ตรงกับ `RICHMENU_NAME` ก่อนเสมอ — **idempotent** รันซ้ำกี่ครั้งก็ได้ผลลัพธ์เดียวกัน
3. สร้าง rich menu ใหม่ (`src/richmenu/build.ts`) — แบ่ง 2×2 พอดี 4 ปุ่มตามสเปก:
   แจ้งเตือน (`rm.list`) / โน้ต-ไฟล์ (`vault.list`) / ตั้งค่า (`settings.view`) / ช่วยเหลือ (`help`)
   ทุกปุ่มเป็น postback ล้วน ใช้ path เดียวกับปุ่มอื่นในแอป (encode/decode + zod validate)
4. อัปโหลดรูปและตั้งเป็นเมนูเริ่มต้น (`setDefaultRichMenu`)

**ข้อจำกัดของ LINE ที่ต้องรู้:** rich menu แสดง**เฉพาะแชท 1:1**เท่านั้น ไม่โผล่ในกลุ่ม/ห้อง —
ไม่ใช่บั๊กของเรา เป็นข้อจำกัดของแพลตฟอร์ม

### ตั้งค่า (v1: เฉพาะช่วงเวลาเงียบ)

ปุ่ม "ตั้งค่า" เปิด Flex แสดงแผน + ช่วงเวลาเงียบปัจจุบัน พร้อมปุ่มปรับเวลาเริ่ม/สิ้นสุด
(`datetimepicker` mode `time`) และปุ่มเปิด/ปิดช่วงเวลาเงียบทั้งชุด

ขอบเขต v1 แค่ช่วงเวลาเงียบ เพราะเป็น setting เดียวที่มีผลจริงกับพฤติกรรมของระบบอยู่แล้ว (ใช้เลื่อนเวลา
เตือนซ้ำที่ตกในช่วงเงียบมาตั้งแต่ P3) — ไม่ทำเรื่อง plan/tz เพราะ v1 ยังไม่มี flow เปลี่ยนแผนหรือเปลี่ยน tz จริง

---

## ทดสอบโดยไม่ต้องมี LINE จริง

`scripts/send-webhook.ts` ยิง webhook ปลอมเข้าเครื่องตัวเอง **พร้อมเซ็น `X-Line-Signature` ให้ถูกต้อง**
ทำให้เทสต์ทั้งเส้นได้โดยไม่ต้องมี ngrok

```bash
npm run webhook:send -- "เตือนกินยาหลังอาหารเย็น 18.00"      # แชท 1:1
npm run webhook:send -- --group "นามิ เตือนส่งรายงานทุกศุกร์"  # ในกลุ่ม (ถูกเรียก → ตอบ)
npm run webhook:send -- --group "กินข้าวกันยังพวกเรา"          # ในกลุ่ม (ไม่ถูกเรียก → เงียบ)
npm run webhook:send -- --follow                              # event เพิ่มเพื่อน
npm run webhook:send -- --bad-signature "ทดสอบ"               # ต้องได้ 401

# ทดสอบปุ่ม rich menu / postback อื่นๆ โดยไม่ต้องกดจริงบนมือถือ
npm run webhook:send -- --postback '{"a":"rm.list"}'                # ปุ่ม "แจ้งเตือน"
npm run webhook:send -- --postback '{"a":"vault.list"}'             # ปุ่ม "โน้ต-ไฟล์"
npm run webhook:send -- --postback '{"a":"settings.view"}'          # ปุ่ม "ตั้งค่า"
npm run webhook:send -- --postback '{"a":"settings.quiet_start"}' --params '{"time":"23:00"}'
```

### ทดสอบ NLU กับโมเดลจริง

```bash
npm run llm:bench                                        # 6 เคสมาตรฐาน
npm run nlu:probe -- "เตือนวันศุกร์ 2 ทุ่ม ดูหนัง"          # ยิงซ้ำ 3 รอบ ดูว่าผลนิ่งไหม
```

`nlu:probe` ยิงข้อความเดียวกัน 3 รอบ ใช้แยกว่าโมเดล "พลาดเป็นระบบ" (ผลเหมือนกันทุกรอบ →
แก้ด้วยโค้ดใน `thaiTime.ts`) หรือ "ไม่นิ่ง" (ผลต่างกัน → แก้ด้วย prompt/threshold)

`replyToken` เป็นของปลอม → LINE จะปฏิเสธการ reply (401) เป็นเรื่องปกติ
ให้ดูใน log ของ worker ว่าประมวลผล event ไปถึงขั้นไหน

### endpoint ตรวจสุขภาพ

```bash
curl localhost:3100/healthz   # liveness — ไม่แตะ dependency
curl localhost:3100/readyz    # readiness — เช็ค postgres + redis จริง
```

---

## รันทั้งชุดในคอนเทนเนอร์

```bash
docker compose --profile app up --build
```

จะได้ `nami-app` + `nami-worker` เพิ่มขึ้นมา (ใช้ตอนอยากทดสอบให้เหมือน production)

---

## เทสต์

```bash
npm test           # vitest run
npm run typecheck  # tsc ทั้ง repo (รวม tests/ และ scripts/)
```

เทสต์ทุกตัวรันบน `TZ=UTC` โดยตั้งใจ — เพื่อพิสูจน์ว่าโค้ดไม่แอบพึ่ง timezone ของเครื่อง
ถ้าเทสต์ผ่านแค่ตอนเครื่องเป็นเวลาไทย นั่นคือบั๊ก

| ไฟล์ | ครอบคลุม |
|------|----------|
| `tests/signature.test.ts` | HMAC ตรงสูตร LINE, ต้องคำนวณจาก raw byte ไม่ใช่ JSON ที่ re-stringify, ไม่ throw เมื่อความยาว signature ไม่เท่ากัน |
| `tests/time.test.ts` | เวลาไทย vs UTC ข้ามวัน/ข้ามเดือน, quiet hours ที่ข้ามเที่ยงคืน, การเลื่อนเวลาออกจากช่วงเงียบ, การแสดงผลภาษาไทย |
| `tests/groupGate.test.ts` | กติกา "ในกลุ่มตอบเฉพาะเมื่อถูกเรียก", ตัด mention หลายตำแหน่งโดย index ไม่เพี้ยน, ไม่ตอบเมื่อ mention คนอื่น |
| `tests/webhook.test.ts` | 401 เมื่อ signature ผิด/ไม่มี, 200 + enqueue เมื่อถูก, `jobId = webhookEventId`, 500 เมื่อ enqueue พังเพื่อให้ LINE retry |
| `tests/llm.test.ts` | zod ไม่ผ่าน → `ok:false` ไม่เดาค่า, repair pass 1 ครั้ง, `api_error` ไม่ repair, บันทึกต้นทุนแม้ผลลัพธ์พัง, `toStrictJsonSchema` บังคับ `additionalProperties:false` + `required` ทุก key |
| `tests/thaiTime.test.ts` | คำบอกเวลาไทยทุกรูปแบบ (ตี/โมงเช้า/บ่าย/โมงเย็น/ทุ่ม/ครึ่ง/เลขไทย), เคสที่โมเดลพลาดจริง, `นับ "N โมง" ที่กำกวมแล้วไม่เดา`, `วันศุกร์หน้า` vs `วันศุกร์นี้`, กฎ `looksRecurring` |
| `tests/resolveTime.test.ts` | แปลงเวลาไทย → UTC, เวลาผ่านไปแล้วเลื่อนวัน/ถามกลับ, ข้ามสิ้นเดือน/สิ้นปี, 31 ก.ย. และ 29 ก.พ. ที่ไม่มีจริง, tz ที่มี DST |
| `tests/nlu.test.ts` | เกณฑ์ถามกลับ (2 สัญญาณ), ข้อความถามกลับ, prompt มีกฎเวลาไทยครบ, JSON Schema ที่ส่งให้โมเดลไม่มี keyword ที่ strict mode ปฏิเสธ |
| `tests/postback.test.ts` | round-trip ทุก action, ปฏิเสธ uuid ปลอม/action ที่ไม่รู้จัก/data เกิน 300 ตัว |
| `tests/flex.test.ts` | ปุ่มถูกชนิด (datetimepicker/postback), `min` กันเลือกอดีต, บอกผู้ใช้เมื่อเลื่อนวันให้, ข้อความ mention ที่ยังไม่รู้ userId |
| `tests/reminders.test.ts` | **integration กับ Postgres จริง** — ทรานแซกชัน, `unique(reminderId, fireAtUtc)` กันยิงซ้ำ, ปฏิเสธการยกเลิก/แก้ของแชทอื่น, `onDelete: Restrict`/`Cascade` |
| `tests/nextOccurrence.test.ts` | รายวัน/สัปดาห์/เดือน/ปี/ทุก N นาที, **วันที่ 31 ต้องข้ามเดือนที่ไม่มี**, 29 ก.พ. อธิกสุรทิน, `BYMONTHDAY=-1`, **DST ทั้งสองทิศ**, quiet hours ที่ไม่ทำตารางเพี้ยนสะสม |
| `tests/scheduler.test.ts` | **integration กับ Postgres จริง** — **ยิงพร้อมกัน 5 ตัว push ถูกเรียกครั้งเดียว**, retry 3 ครั้งแล้ว failed, โควตาหมดไม่ retry, กู้แถวที่ค้างในสถานะ `sending`, `jobId = occurrence id`, horizon 1 ชม., snooze สร้างแถวใหม่ไม่แก้แถวเดิม, **@mention: ยิง textV2+Flex คู่กัน, fallback เป็น Flex อย่างเดียวเมื่อ mention พลาด, ไม่มี mention เมื่อยังไม่รู้จักคนนั้น** |
| `tests/vault.test.ts` | **integration กับ Postgres + MinIO จริง (mock เฉพาะ S3/LINE)** — โควตาสะสมตลอดกาล, ไม่สร้างแถวถ้าดาวน์โหลด/อัปโหลดพลาด, ลบไฟล์จริงจาก storage, hybrid search (tsvector/trgm/pgvector), แยกแชทถูก, `extractUrls` |
| `tests/mentionResolve.test.ts` | **integration กับ Postgres จริง** — จับคู่ตรงเป๊ะ/substring ทั้งสองทิศทาง, ชื่อซ้ำ/จับได้หลายคน → ไม่เดา, แยกกลุ่มถูก |
| `tests/mentionMessage.test.ts` | สร้าง `textV2` + `substitution` ครบทุกคน, placeholder `{m0}`/`{m1}` ตรงกับ mentionee |
| `tests/richmenu.test.ts` | ขนาดตรงสเปก, 4 ปุ่มครอบคลุมพื้นที่เต็มพอดีไม่ทับกัน, ทุกปุ่ม decode ได้จริง, deterministic |
| `tests/settings.test.ts` | **integration กับ Postgres จริง** — ค่าดีฟอลต์จาก env, ปรับเริ่ม/สิ้นสุดแยกกันไม่กระทบกัน, ปิดแล้ว `isInQuietHours` เป็น false ทุกนาที, เปิดกลับด้วยค่าดีฟอลต์ |
| `tests/resolveImageItem.test.ts` | แปลงวันที่+เวลาจากเอกสารเป็น UTC, รองรับเวลาไทยผ่าน `extractClockMinute` เดียวกับข้อความ, **ช่วงเวลาแบบตารางเวร ("07-15") ใช้จุดเริ่มต้น**, ปีผิดปกติ (พ.ศ./ค.ศ.) → ปฏิเสธ |
| `tests/draftService.test.ts` | **integration กับ Postgres จริง** — round-trip payload ผ่าน JSON, **ยืนยันพร้อมกัน 5 ครั้งสร้างแค่ชุดเดียว (claim แบบ atomic)**, ข้าม item ที่อ่านไม่ออก, draft หมดอายุ/ของแชทอื่นปฏิเสธ |

> `tests/reminders.test.ts` ต้องมี Postgres รันอยู่ (`docker compose up -d postgres`)
> `tests/globalSetup.ts` จะรัน migration ลง DB ชื่อ `nami_test` ให้เอง
> ถ้าต่อ DB ไม่ได้ เทสต์ชุดนั้นจะข้ามตัวเองแทนที่จะทำทั้งชุดพัง

### ตรวจโครงสร้าง DB ที่ Prisma จัดการแทนไม่ได้

```bash
npm run db:verify
```

เช็คว่า trigger, expression index (trgm) และ HNSW index ยังอยู่ครบ
**ต้องรันทุกครั้งหลัง generate migration ใหม่** — ดูเหตุผลใน "กับดักของ Prisma" ด้านล่าง

---

## โครงสร้าง

```
src/
├─ index.ts             เข้า API process (webhook เท่านั้น)
├─ config/env.ts        validate env ด้วย zod ตอน boot — ขาดตัวไหนตายทันที
├─ lib/
│  ├─ logger.ts         pino + redact ค่าความลับ
│  ├─ prisma.ts         Prisma client
│  ├─ redis.ts          ioredis (maxRetriesPerRequest: null ตามที่ BullMQ ต้องการ)
│  └─ time.ts           เวลาไทยทั้งหมดอยู่ที่นี่ — quiet hours, format, แปลง local↔UTC
├─ line/
│  ├─ postback.ts       encode/decode postback + zod (data จากเครื่องผู้ใช้ เชื่อไม่ได้)
│  ├─ flex/
│  │  ├─ theme.ts       สี/ขนาดกลาง
│  │  ├─ reminderConfirm.ts   ยืนยันตอนตั้ง (รองรับทั้งครั้งเดียวและซ้ำ)
│  │  ├─ reminderFire.ts      ตอนยิง — เสร็จแล้ว/เลื่อน 10 นาที/เลื่อน 1 ชม./ปิด
│  │  ├─ reminderList.ts      carousel + ปุ่มแก้เวลา/ลบรายตัว
│  │  ├─ vaultSearchResult.ts carousel ผลค้นหา + ปุ่มเปิดลิงก์/ขอไฟล์กลับ
│  │  └─ imageReminderReview.ts รายการที่อ่านได้จากรูป + ปุ่มยืนยันทั้งหมด/ไม่ต้อง
│  ├─ signature.ts      verify X-Line-Signature (timing-safe)
│  ├─ client.ts         MessagingApiClient + BlobClient
│  ├─ reply.ts          reply (ฟรี)
│  ├─ push.ts           push (มีค่าใช้จ่าย) — ทางเดียวที่อนุญาตให้ push
│  ├─ mentionMessage.ts textV2 + substitution — mention จริงที่กดแล้วเด้งแจ้งเตือน
│  └─ usage.ts          นับ push / llm token / storage ลง usage_counters
├─ webhook/
│  ├─ server.ts         Fastify + parser ที่เก็บ raw body ไว้คำนวณ signature
│  ├─ routes.ts         POST /webhook — verify → enqueue → 200
│  └─ health.ts         /healthz /readyz /debug/line-config
├─ llm/
│  ├─ client.ts         openai SDK ชี้ไป OpenRouter + อ่าน usage.cost
│  ├─ chat.ts           completeStructured() — ทางเดียวที่เรียกโมเดลได้
│  ├─ embed.ts          embeddings + เช็คมิติให้ตรงกับ DB
│  └─ jsonSchema.ts     zod → JSON Schema แบบ strict
├─ queue/queues.ts      BullMQ: events / reminder-fire / scheduler
├─ handlers/
│  ├─ index.ts          กระจาย event ตามชนิด
│  ├─ message.ts        ข้อความ → NLU → ตรวจทาน → บันทึก → Flex
│  ├─ postback.ts       ปุ่มทั้งหมด
│  ├─ context.ts        upsert chat/user/group_member — จำ userId ทุกคนที่พูดในกลุ่ม
│  ├─ groupGate.ts      กติกา "ตอบเฉพาะเมื่อถูกเรียก" ในกลุ่ม
│  ├─ mentionResolve.ts จับคู่ชื่อที่ NLU ดึงมา → userId จาก group_members
│  ├─ settings.ts       ตั้งค่าช่วงเวลาเงียบ (ปุ่มเมนู "ตั้งค่า")
│  └─ lifecycle.ts      unfollow/leave → ปิดแชท หยุดยิง push
├─ worker/
│  ├─ index.ts          เข้า worker process (3 worker)
│  ├─ eventWorker.ts    ประมวลผล event + กันซ้ำ 2 ชั้น
│  ├─ fireWorker.ts     ยิงเตือน + retry exponential backoff
│  └─ schedulerWorker.ts  repeatable job กวาดทุก 1 นาที
├─ nlu/
│  ├─ schema.ts         zod schema ของผล NLU (แหล่งความจริงเดียว)
│  ├─ prompt.ts         system prompt + กฎเวลาไทย
│  ├─ parse.ts          เรียก NLU + เกณฑ์ถามกลับ
│  ├─ resolveTime.ts    dueAtLocal → UTC + กฎเวลาที่ผ่านไปแล้ว
│  ├─ thaiTime.ts       ตัวตรวจทานคำบอกเวลาไทย (deterministic)
│  ├─ imageSchema.ts    zod schema ของผลอ่านรูป (feature 3)
│  ├─ imagePrompt.ts    system prompt สำหรับ vision
│  ├─ parseImage.ts     เรียก vision (tier: 'vision') + ตรวจทานทุกรายการ
│  └─ resolveImageItem.ts ตรวจทานเวลา/วันที่ต่อรายการ (deterministic เหมือน thaiTime.ts)
├─ reminders/
│  ├─ service.ts        CRUD การเตือน (ทรานแซกชัน + เช็คว่าเป็นของแชทนั้น)
│  └─ draftService.ts   ReminderDraft: create/confirm/discard (feature 3)
├─ scheduler/
│  ├─ nextOccurrence.ts คำนวณรอบถัดไป (floating date trick + quiet hours)
│  ├─ fire.ts           claim → push → sent + กู้แถวค้าง
│  └─ enqueue.ts        enqueue horizon 1 ชม. + sweeper + ลบ job ของแชทที่ปิด
├─ vault/
│  ├─ storage.ts        S3 client (MinIO/R2) — upload/delete/signed URL
│  ├─ download.ts       ดาวน์โหลด content จาก LINE (ต้องทำก่อนไฟล์หมดอายุ)
│  ├─ mime.ts           เดา MIME จากชนิด message / นามสกุลไฟล์
│  ├─ quota.ts          โควตาพื้นที่เก็บ — สะสมตลอดกาล ไม่ใช่รายเดือน
│  ├─ service.ts        save/delete vault item + แนบ embedding
│  ├─ search.ts         hybrid search (tsvector + word_similarity + pgvector)
│  └─ urls.ts           ดึง URL จากข้อความด้วย regex (ไม่ผ่าน LLM)
├─ richmenu/build.ts    สร้าง RichMenuRequest (2×2, 4 ปุ่ม, postback ล้วน)
└─ copy.ts              ข้อความที่ซ้ำกันหลายจุด (แก้คำที่เดียวตรงกันทุกจุด)
```

---

## หมายเหตุการออกแบบที่ควรรู้

### เวลา
- **DB เก็บ UTC เสมอ** (`timestamptz`) — แสดงผลเป็นเวลาไทยเสมอ
- ห้ามใช้ `new Date()` คำนวณวันที่ ให้ผ่าน luxon + zone ตลอด เพราะเซิร์ฟเวอร์อาจรันบน TZ อะไรก็ได้
- `quiet_hours_start/end` เก็บเป็น **นาทีนับจากเที่ยงคืน** (int) ไม่ใช่ `time`
  เพราะต้องคำนวณช่วงที่ข้ามเที่ยงคืนได้ (22:00 → 07:00 = `1320 → 420`)

### กันยิงซ้ำ
webhook event กันซ้ำ **2 ชั้น**:
1. `jobId = webhookEventId` — BullMQ ปฏิเสธ job ที่ id ซ้ำ (กันในช่วงที่ job ยังอยู่ใน Redis)
2. ตาราง `processed_events` — กันถาวร กรณี LINE retry หลัง job หมดอายุไปแล้ว

บันทึกลง `processed_events` **หลัง** ทำงานสำเร็จเท่านั้น ไม่งั้น job ที่ fail แล้ว retry จะถูกมองว่าทำไปแล้วและข้ามทิ้ง

### ต้นทุน push
`reply` ฟรี แต่ `push` มีโควตา/มีค่าใช้จ่าย → **ทุกการ push ต้องผ่าน `src/line/push.ts`** เท่านั้น
ฟังก์ชันนั้นจะ (1) เช็คว่าแชทยัง active (2) เช็ค soft limit ตาม plan (3) นับลง `usage_counters` (4) log ต้นทุน

soft limit ตั้งได้ที่ `PUSH_SOFT_LIMIT_FREE` / `PUSH_SOFT_LIMIT_PRO`

### การ mention คนในกลุ่ม
LINE ไม่ให้ list สมาชิกกลุ่ม (ถ้าไม่ใช่ verified OA) → เราต้องสะสม `userId` เอง
`resolveContext()` จึงเก็บ `event.source.userId` ลง `group_members` **ทุกครั้งที่มีคนพูด**
แม้ข้อความนั้นนามิจะไม่ตอบก็ตาม

ถ้ายังไม่รู้ userId ของคนที่ผู้ใช้อยากให้ mention → นามิจะตอบว่า
*"ให้คนนั้นพิมพ์ในกลุ่มครั้งนึงก่อนนะ นามิจะจำไว้"*

ชื่อดึงด้วย `getGroupMemberProfile` (ใช้ได้แม้คนนั้นไม่ได้เป็นเพื่อนกับบอท) และ cache ไว้ 7 วันเพื่อไม่ยิง API ทุกข้อความ

### การค้นหาใน vault (P4)
- `search_tsv` เติมด้วย **trigger** ไม่ใช่ generated column เพราะ `array_to_string()` เป็น `STABLE`
  (generated column ต้อง `IMMUTABLE`) และ Prisma diff จะมองเห็น generated column เป็น drift ทุกครั้ง
- **PostgreSQL ไม่มี text search config สำหรับภาษาไทย** และภาษาไทยไม่เว้นวรรคระหว่างคำ
  → `to_tsvector('simple', ...)` จับได้ดีแค่คำอังกฤษ/ชื่อไฟล์/ตัวเลข
  → การค้นคำไทยพึ่ง **pg_trgm** (จับ substring) + **pgvector** (semantic) เป็นหลัก
- Anthropic API ไม่มี embeddings endpoint → ใช้ **Voyage AI** (`voyage-3`, 1024 dims)
  ถ้าไม่ตั้ง `VOYAGE_API_KEY` ระบบจะ fallback ไปใช้ full-text + trgm เพียงอย่างเดียว (semantic หายไป แต่ยังใช้ได้)

### กับดักของ Prisma ที่ต้องระวังทุกครั้ง

`prisma migrate diff` **มองไม่เห็น** 3 อย่างนี้ และจะสั่ง `DROP` หรือละเลยมันทุกครั้งที่ generate migration:

| ของ | อาการ | ทางแก้ |
|---|---|---|
| HNSW index บน `embedding` | ถูก `DROP` ทุกครั้ง | เติม `CREATE INDEX ... USING hnsw` ท้าย migration กลับไปเสมอ |
| การเปลี่ยนมิติ `Unsupported("vector(N)")` | ถูกละเลยเงียบๆ | เขียน `ALTER TABLE` เอง |
| trigger + expression index (trgm) | ถูกละเลย (ยังอยู่ แต่ diff ไม่รู้จัก) | ปล่อยไว้ได้ |

GIN index บน `search_tsv` และ `tags` ย้ายเข้าไปประกาศใน schema แล้ว (`@@index([...], type: Gin)`)
จึงไม่ drift อีก

**หลัง generate migration ใหม่ทุกครั้ง:**

```bash
npm run db:verify
```

ถ้ามีอะไรหาย มันจะบอกว่าหายอะไรและ exit code ไม่ใช่ 0

### LLM
ทุกครั้งที่เรียก LLM ต้อง validate output ด้วย zod และมี fallback ถ้า parse ไม่ได้ —
**ถามผู้ใช้กลับ อย่าเดา** บังคับใช้ผ่าน `completeStructured()` แล้ว

ดูรายละเอียดว่าทำไมต้องมีตัวตรวจทานเป็นโค้ดที่หัวข้อ
[NLU: ทำไมต้องมีตัวตรวจทานเป็นโค้ด](#nlu-ทำไมต้องมีตัวตรวจทานเป็นโค้ด)

### Vault: similarity() vs word_similarity()

`pg_trgm` มีสองฟังก์ชันที่หน้าตาคล้ายกันแต่ใช้ผิดจุดประสงค์ไม่ได้เลย:

- `similarity(a, b)` เทียบ **ทั้งสตริง** กับ **ทั้งสตริง** — ใช้ตอนอยาก "จับคู่สองข้อความที่คล้ายกันโดยรวม"
- `word_similarity(needle, haystack)` หา **substring ที่ตรงที่สุด** ของ haystack ให้ needle —
  ใช้ตอนอยาก "ค้นคำสั้นๆ ในเอกสารที่ยาวกว่า" ซึ่งคือโจทย์ของ vault search

ใช้ `similarity()` ตอนแรกแล้วพังตอน e2e จริง (ไม่ใช่ unit test — ข้อความเทสต์สั้นเกินจะเจอปัญหานี้):
ค้นคำว่า "สัญญา" ในข้อความยาว 50+ ตัวอักษร ได้คะแนนแค่ 0.07 เพราะสตริงทั้งสองฝั่งยาวไม่เท่ากันมาก
`similarity()` จึงถูกเจือจางจนต่ำกว่า threshold ทุกกรณี — ค้นหาไม่เจออะไรเลยทั้งที่ข้อมูลมีอยู่จริง
สลับไป `word_similarity()` แล้วได้ 0.6-0.8 สำหรับ query เดียวกัน แก้ปัญหาได้ทันที

**ถ้าจะเพิ่มการค้น substring ของ pg_trgm ที่ไหนอีกในโปรเจกต์นี้ ให้ใช้ `word_similarity()` เป็นค่าเริ่มต้น
ไม่ใช่ `similarity()`**

---

## ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|-------|-----------------|
| `EADDRINUSE :3100` | มี process อื่นใช้พอร์ตอยู่ เปลี่ยน `PORT` ใน `.env` |
| `Ports are not available: 5432` | มี Postgres ตัวอื่นบนเครื่อง — compose ใช้ `55432` อยู่แล้ว ถ้ายังชนให้เปลี่ยนใน `docker-compose.yml` + `DATABASE_URL` |
| webhook ได้ 401 ทุกครั้ง | `LINE_CHANNEL_SECRET` ไม่ตรงกับ channel ที่ตั้ง webhook ไว้ |
| LINE กด Verify ไม่ผ่าน | ngrok ไม่ได้รัน / URL ใน console เป็นของ ngrok เก่า / ลืมต่อ `/webhook` |
| นามิไม่ตอบในกลุ่ม | ตั้งใจ — ในกลุ่มต้อง `@นามิ` หรือขึ้นต้นด้วย "นามิ" |
| มีข้อความอื่นตอบทับนามิ | ยังไม่ปิด "การตอบกลับอัตโนมัติ" ใน LINE OA Manager |
| `Queue name cannot contain ':'` | BullMQ ใช้ `:` เป็นตัวคั่น redis key ให้จัด namespace ด้วย option `prefix` |
| LLM คืน `not_configured` | ยังไม่ได้ตั้ง `OPENROUTER_API_KEY` |
| LLM คืน `schema_mismatch` ตลอด | โมเดลที่ตั้งไว้ไม่รองรับ `json_schema` strict — เช็คด้วย `/debug/llm-config` แล้วเปลี่ยนโมเดล |
| embedding พังตอน insert | `EMBEDDING_DIMENSIONS` ไม่ตรงกับ `vector(N)` ใน DB — รัน `npm run db:verify` |
| ต่อ Supabase ไม่ได้จากเน็ตองค์กร | `db.<ref>.supabase.co` เป็น IPv6-only และเน็ตองค์กรมักบล็อก outbound 5432/6543 — dev ให้ใช้ Postgres ใน docker แล้วต่อ Supabase ตอน deploy |
| `.env` sourcing พังใน shell | ค่าที่มีช่องว่างต้องครอบ quote เช่น `OPENROUTER_APP_NAME="Nami LINE Assistant"` |
| ตั้งเตือนแล้วแต่ไม่มีอะไรเตือน | ต้องรัน `npm run dev:worker` ด้วย — scheduler อยู่ใน worker process ไม่ใช่ API |
| `does not provide an export named 'RRule'` | `rrule` เป็น CJS ต้อง default import แล้วแตกเอง (vitest transpile ให้ผ่านแต่ Node จริงพัง) |
| การเตือนซ้ำไปยิงตอนดึกทั้งที่ตั้งเช้า | เคยเป็นบั๊กที่โมเดลส่งชั่วโมงมาแทนนาทีจากเที่ยงคืน — `resolveFireMinute()` คุมแล้ว |
| `schema_mismatch: dueAtLocal` | โมเดลเติมวินาทีมาให้เอง — `LOCAL_DATETIME_LOOSE_RE` รับแล้วตัดทิ้ง |
| นามิตอบว่า "เตือนซ้ำยังทำไม่ได้" ทั้งที่ตั้งครั้งเดียว | ข้อความมีคำที่ `looksRecurring()` จับว่าเป็นการซ้ำ ดูกฎในหัวข้อ NLU |
| ค้น vault ไม่เจอทั้งที่มีข้อมูลอยู่จริง | ต้องใช้ `word_similarity()` ไม่ใช่ `similarity()` — ดูหัวข้อ "Vault: similarity() vs word_similarity()" |
| อัปโหลดไฟล์ล้มเหลว ต่อ MinIO ไม่ได้ | เช็ค `docker compose ps` ว่า `nami-minio` รันอยู่ และ `minio-init` สร้าง bucket สำเร็จ (`docker compose logs minio-init`) |
| นามิตอบว่ายังต่อสมองไม่ได้ตอนส่งลิงก์/ไฟล์ | เก็บลิงก์/ไฟล์ไม่ต้องใช้ LLM เลย — ถ้าเจอข้อความนี้แปลว่าเป็นข้อความอื่นที่ปนมา ไม่ใช่จากการเก็บ vault |
| นามิถามคำถามที่ไม่เกี่ยวข้อง (เช่นถาม "กี่โมง" ตอนขอเก็บลิงก์) | โมเดลใส่ `ambiguousFields` มาแม้ intent จะไม่ใช่ `create_reminder` — `sanitizeNluResult()` ต้องกรองออก ดูหัวข้อ "ambiguousFields เป็นเรื่องของการตั้งเตือนเท่านั้น" |
| มอบหมายคนในกลุ่มแล้วนามิบอกว่าไม่รู้จัก | คนนั้นต้องเคยพิมพ์ในกลุ่มมาก่อน (นามิรู้จักจาก `group_members` เท่านั้น) และชื่อต้องไม่ซ้ำ/กำกวมกับคนอื่นในกลุ่ม |
| ยิงเตือนแล้วไม่มี @mention ทั้งที่ตอนตั้งเตือนบอกว่ารู้จักคนนั้น | ปกติถ้า push พร้อม mention พลาด (เช่นคนนั้นออกจากกลุ่มไปแล้ว) — `fireOccurrence()` จะ fallback ส่งแค่ Flex แทนอัตโนมัติ ดู log หา `"push พร้อม mention พลาด"` |
| กด rich menu ในกลุ่มไม่เห็นเมนู | ตั้งใจ — ข้อจำกัดของ LINE: rich menu โผล่เฉพาะแชท 1:1 เท่านั้น |
| `npm run richmenu:setup` หา Chrome ไม่เจอ | ติดตั้ง Google Chrome หรือ Chromium หรือแก้ `CHROME_CANDIDATES` ใน `scripts/setup-richmenu.ts` ให้ตรงกับ path จริง |
| รันเมนู setup ซ้ำแล้วมีเมนูซ้ำค้างใน LINE Developers Console | ไม่ควรเกิด — สคริปต์ลบของเก่าชื่อเดียวกัน (`RICHMENU_NAME`) ก่อนสร้างใหม่เสมอ ถ้าเจอให้เช็คว่าไม่ได้แก้ `RICHMENU_NAME` เป็นคนละค่าระหว่างรัน |
| ตั้งเตือนจากรูปตารางเวรได้เวลาผิด (ไม่ตรงหัวคอลัมน์) | เคยเป็นบั๊กตอนโมเดลคัดลอกทั้งช่วงเวลามา ("07-15") ไม่ใช่จุดเดียว — `extractRangeStart()` ใน `resolveImageItem.ts` แก้แล้ว ใช้จุดเริ่มต้นของช่วงเสมอ |
| ส่งรูปแล้วไม่มี Flex ให้ยืนยันเตือน | ปกติถ้ารูปนั้นไม่ใช่เอกสารที่มีอะไรให้เตือน (docType=other, reminders ว่าง) — นามิจะแค่ตอบว่าเก็บรูปให้แล้วเฉยๆ |
| `npm run richmenu:setup` ทำงานแบบตรงไปสร้าง/ตั้งเมนูจริงทันที ไม่ถามก่อน | ตั้งใจ — เป็น script ที่ผู้ใช้สั่งรันเองตรงๆ ถือว่าเจตนาชัดเจนแล้ว **ไม่ควรรันคำสั่งนี้ (หรือคำสั่งไหนที่แตะ LINE API จริง) เพื่อ "ทดสอบเฉยๆ" โดยไม่ได้ตั้งใจจะ deploy จริง** โดยเฉพาะถ้า `.env` มี credential จริงอยู่แล้ว |
