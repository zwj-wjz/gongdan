/**
 * AI 车牌识别代理（Vercel Serverless Function）
 *
 * 作用：把硅基流动的密钥留在服务端，浏览器永远拿不到。
 *
 * 部署前必须在 Vercel 控制台 → Settings → Environment Variables 配置：
 *   SILICON_API_KEY   硅基流动的 sk-... 密钥（必填）
 *   SILICON_MODEL     可选，默认 Qwen/Qwen3-VL-30B-A3B-Instruct
 *   SUPABASE_URL      可选，默认用下面的项目地址
 *   SUPABASE_ANON_KEY 可选，默认用下面的 publishable key
 *
 * 请求头必须带 Authorization: Bearer <登录后的 access_token>，
 * 否则任何人都能拿这个接口刷你的 AI 额度。
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://umatcwaodotqpttbuwew.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ULquGaSNnY9G11RJcKLx_g_Xmcev2ig';
const SILICON_API_KEY = process.env.SILICON_API_KEY || '';
const SILICON_MODEL = process.env.SILICON_MODEL || 'Qwen/Qwen3-VL-30B-A3B-Instruct';
const SILICON_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';

// base64 字符串长度上限（约 4MB 原始图片），防止有人拿超大 payload 打爆函数
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;

const PROMPT = '请识别图片里的车牌号和车型，用 JSON 格式输出，例如：{"车牌号": "川C·12345", "车型": "吉利几何"}。识别不到就填"未识别"。只返回 JSON，不要任何多余文字。';

/** 校验调用方是否是一个已登录的 Supabase 用户 */
async function verifyUser(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;

    try {
        const resp = await fetch(SUPABASE_URL + '/auth/v1/user', {
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
        });
        if (!resp.ok) return null;
        const user = await resp.json();
        return user && user.id ? user : null;
    } catch (e) {
        console.error('verifyUser failed', e);
        return null;
    }
}

/** 把模型回复解析成 { plate, model }，兼容纯 JSON 和带文字说明两种情况 */
function parseReply(reply) {
    const text = String(reply || '').trim();
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    try {
        const obj = JSON.parse(cleaned);
        return {
            plate: String(obj['车牌号'] || obj.plate || '').trim(),
            model: String(obj['车型'] || obj.model || '').trim()
        };
    } catch (e) {
        const plate = (text.match(/车牌号[：:]\s*([^\s,，。"'}]+)/) || [])[1] || '';
        const model = (text.match(/车型[：:]\s*([^\s,，。"'}]+)/) || [])[1] || '';
        return { plate: plate.trim(), model: model.trim() };
    }
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: '只支持 POST 请求' });
    }

    if (!SILICON_API_KEY) {
        console.error('SILICON_API_KEY is not set');
        return res.status(500).json({ error: '服务端未配置 AI 密钥，请联系管理员' });
    }

    const user = await verifyUser(req);
    if (!user) {
        return res.status(401).json({ error: '登录已失效，请重新登录' });
    }

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = null; }
    }
    const image = body && body.image;

    if (typeof image !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
        return res.status(400).json({ error: '图片格式不支持，请重新拍摄' });
    }
    if (image.length > MAX_IMAGE_CHARS) {
        return res.status(413).json({ error: '图片过大，请重新拍摄' });
    }

    try {
        const resp = await fetch(SILICON_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + SILICON_API_KEY
            },
            body: JSON.stringify({
                model: SILICON_MODEL,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: PROMPT },
                        { type: 'image_url', image_url: { url: image } }
                    ]
                }],
                max_tokens: 150
            })
        });

        if (!resp.ok) {
            const detail = await resp.text();
            // 详细错误只进服务端日志，不回传给浏览器
            console.error('siliconflow failed', resp.status, detail.slice(0, 300));
            return res.status(502).json({
                error: resp.status === 401 ? 'AI 服务密钥无效，请联系管理员' : 'AI 服务暂时不可用，请稍后重试'
            });
        }

        const data = await resp.json();
        const reply = (data && data.choices && data.choices[0] && data.choices[0].message)
            ? data.choices[0].message.content
            : '';
        const parsed = parseReply(reply);

        return res.status(200).json({
            plate: parsed.plate,
            model: parsed.model,
            raw: String(reply || '').slice(0, 300)
        });
    } catch (e) {
        console.error('ai proxy error', e);
        return res.status(500).json({ error: '识别服务异常，请稍后重试' });
    }
};
