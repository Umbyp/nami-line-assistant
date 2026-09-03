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
| P2 | NLU + ตั้งเตือนรายครั้ง + Flex ยืนยัน | ⬜ |
| P3 | scheduler + เตือนซ้ำ + postback แก้/ยกเลิก | ⬜ |
| P4 | vault เก็บ + ค้นหา | ⬜ |
| P5 | โหมดกลุ่ม + mention | ⬜ |
| P6 | rich menu + ขัดเกลาข้อความ + test | ⬜ |

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

## ทดสอบโดยไม่ต้องมี LINE จริง

`scripts/send-webhook.ts` ยิง webhook ปลอมเข้าเครื่องตัวเอง **พร้อมเซ็น `X-Line-Signature` ให้ถูกต้อง**
ทำให้เทสต์ทั้งเส้นได้โดยไม่ต้องมี ngrok

```bash
npm run webhook:send -- "เตือนกินยาหลังอาหารเย็น 18.00"      # แชท 1:1
npm run webhook:send -- --group "นามิ เตือนส่งรายงานทุกศุกร์"  # ในกลุ่ม (ถูกเรียก → ตอบ)
npm run webhook:send -- --group "กินข้าวกันยังพวกเรา"          # ในกลุ่ม (ไม่ถูกเรียก → เงียบ)
npm run webhook:send -- --follow                              # event เพิ่มเพื่อน
npm run webhook:send -- --bad-signature "ทดสอบ"               # ต้องได้ 401
```

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
│  ├─ signature.ts      verify X-Line-Signature (timing-safe)
│  ├─ client.ts         MessagingApiClient + BlobClient
│  ├─ reply.ts          reply (ฟรี)
│  ├─ push.ts           push (มีค่าใช้จ่าย) — ทางเดียวที่อนุญาตให้ push
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
│  ├─ context.ts        upsert chat/user/group_member — จำ userId ทุกคนที่พูดในกลุ่ม
│  ├─ groupGate.ts      กติกา "ตอบเฉพาะเมื่อถูกเรียก" ในกลุ่ม
│  └─ lifecycle.ts      unfollow/leave → ปิดแชท หยุดยิง push
├─ worker/
│  ├─ index.ts          เข้า worker process
│  └─ eventWorker.ts    ประมวลผล event + กันซ้ำ 2 ชั้น
├─ nlu/                 (P2)
├─ scheduler/           (P3)
└─ vault/               (P4)
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

**สิ่งที่ต้องแก้ใน P2 (พบจาก bench):** `confidence` จากโมเดล **ไม่เสถียร**
ข้อความกำกวมเดียวกัน (`"เตือนตอนเย็นๆ นะ"`) รอบหนึ่งได้ 0.5 อีกรอบได้ 0.7
→ พึ่ง `NLU_CONFIDENCE_THRESHOLD` ตัวเดียวไม่พอ
schema ของ P2 ต้องมี field `ambiguousFields: string[]` ที่บังคับให้โมเดลระบุออกมาตรงๆ
ว่าอะไรกำกวม แล้วถามกลับตามนั้น ไม่ใช่ตัดสินจากตัวเลข confidence อย่างเดียว
(bench ยังพบว่ามันตั้ง `title` เป็น `"เย็นๆ"` ซึ่งเอาวลีบอกเวลามาเป็นชื่อเรื่อง)

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
