/**
 * AI 车牌识别代理（Supabase Edge Function）
 *
 * 为什么不放在 Netlify Functions：Netlify 同步函数上限 10 秒（Free 套餐），
 * 而硅基流动 Qwen3-VL 实测响应 17~30 秒，必然 504。
 * Supabase Edge Function 的 wall-clock 上限是 150 秒，够用。
 *
 * 鉴权：依赖 Supabase 平台层（verify_jwt 默认开启），
 * 没有有效 access_token 的请求进不到这里，所以函数内不再重复校验。
 *
 * 部署：
 *   supabase functions deploy ai --project-ref umatcwaodotqpttbuwew
 * 密钥（不放代码里）：
 *   supabase secrets set SILICON_API_KEY=sk-xxx --project-ref umatcwaodotqpttbuwew
 */

const SILICON_API_KEY = Deno.env.get('SILICON_API_KEY') ?? '';
const SILICON_MODEL = Deno.env.get('SILICON_MODEL') ?? 'Qwen/Qwen3-VL-30B-A3B-Instruct';
const SILICON_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';

// 约 4MB 原始图片的 base64 长度上限
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;

const PROMPT =
    '请识别图片里的车牌号和车型，用 JSON 格式输出，例如：{"车牌号": "川C·12345", "车型": "吉利几何"}。识别不到就填"未识别"。只返回 JSON，不要任何多余文字。';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, obj: unknown) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

/** 兼容纯 JSON 和带说明文字两种回复 */
function parseReply(reply: string) {
    const text = String(reply || '').trim();
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    try {
        const obj = JSON.parse(cleaned);
        return {
            plate: String(obj['车牌号'] ?? obj.plate ?? '').trim(),
            model: String(obj['车型'] ?? obj.model ?? '').trim(),
        };
    } catch {
        const plate = (text.match(/车牌号[：:]\s*([^\s,，。"'}]+)/) ?? [])[1] ?? '';
        const model = (text.match(/车型[：:]\s*([^\s,，。"'}]+)/) ?? [])[1] ?? '';
        return { plate: plate.trim(), model: model.trim() };
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return json(405, { error: '只支持 POST 请求' });

    if (!SILICON_API_KEY) {
        console.error('SILICON_API_KEY is not set');
        return json(500, { error: '服务端未配置 AI 密钥，请联系管理员' });
    }

    let body: { image?: unknown } | null = null;
    try {
        body = await req.json();
    } catch {
        body = null;
    }

    const image = body?.image;
    if (typeof image !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
        return json(400, { error: '图片格式不支持，请重新拍摄' });
    }
    if (image.length > MAX_IMAGE_CHARS) {
        return json(413, { error: '图片过大，请重新拍摄' });
    }

    try {
        const resp = await fetch(SILICON_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SILICON_API_KEY },
            body: JSON.stringify({
                model: SILICON_MODEL,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: PROMPT },
                        { type: 'image_url', image_url: { url: image } },
                    ],
                }],
                max_tokens: 150,
            }),
            signal: AbortSignal.timeout(120_000),
        });

        if (!resp.ok) {
            const detail = await resp.text();
            // 详细错误只进日志，不回传浏览器
            console.error('siliconflow failed', resp.status, detail.slice(0, 300));
            return json(502, {
                error: resp.status === 401 ? 'AI 服务密钥无效，请联系管理员' : 'AI 服务暂时不可用，请稍后重试',
            });
        }

        const data = await resp.json();
        const reply = data?.choices?.[0]?.message?.content ?? '';
        const parsed = parseReply(reply);

        return json(200, {
            plate: parsed.plate,
            model: parsed.model,
            raw: String(reply || '').slice(0, 300),
        });
    } catch (e) {
        console.error('ai proxy error', e);
        const timedOut = e instanceof Error && e.name === 'TimeoutError';
        return json(timedOut ? 504 : 500, {
            error: timedOut ? 'AI 识别超时，请重试或手动填写' : '识别服务异常，请稍后重试',
        });
    }
});
