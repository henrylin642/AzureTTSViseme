import express from 'express';
import dotenv from 'dotenv';
import sdk from 'microsoft-cognitiveservices-speech-sdk';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SPEECH_KEY = process.env.SPEECH_KEY;
const SPEECH_REGION = process.env.SPEECH_REGION;
const DID_API_KEY = process.env.DID_API_KEY;
const DID_API_SECRET = process.env.DID_API_SECRET;
const DID_SOURCE_URL = process.env.DID_SOURCE_URL;
const DID_VOICE_ID = process.env.DID_VOICE_ID || 'zh-TW-HsiaoChenNeural';
const DID_SCRIPT_PROVIDER = process.env.DID_SCRIPT_PROVIDER || 'microsoft';

if (!SPEECH_KEY || !SPEECH_REGION) {
  console.warn('\u26a0\ufe0f  未設定 SPEECH_KEY 或 SPEECH_REGION，請確認 .env 是否完成設定');
}

if (!DID_API_KEY || !DID_API_SECRET) {
  console.warn('\u26a0\ufe0f  未設定 DID_API_KEY 或 DID_API_SECRET，D-ID 數字人功能將無法使用');
}

app.use(express.json());
app.use(express.static('public'));

function isValidHttpUrl(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

async function pollDidTalk(talkId, authHeader, maxAttempts = 15, intervalMs = 2000) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const detailResp = await fetch(`https://api.d-id.com/talks/${talkId}`, {
      headers: {
        Authorization: authHeader,
      },
    });
    const detailData = await detailResp.json().catch(() => ({}));
    if (!detailResp.ok) {
      throw new Error(detailData.error?.message || '查詢 D-ID 任務失敗');
    }

    if (detailData.status === 'done' && detailData.result_url) {
      return detailData;
    }
    if (detailData.status === 'error') {
      throw new Error(detailData.error?.message || 'D-ID 任務失敗');
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('D-ID 任務逾時，請稍後再試');
}

app.post('/api/tts-viseme', async (req, res) => {
  const { text } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text 欄位必須為非空字串' });
  }

  if (!SPEECH_KEY || !SPEECH_REGION) {
    return res.status(500).json({ error: 'SPEECH_KEY 或 SPEECH_REGION 未設定' });
  }

  try {
    // 建立 Azure SpeechConfig，使用訂閱金鑰與區域進行雲端合成
    const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
    speechConfig.speechSynthesisVoiceName = 'zh-TW-HsiaoChenNeural';
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;

    const visemeTimeline = [];
    // 建立 SpeechSynthesizer，並監聽 visemeReceived 事件以收集嘴型資訊
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
    synthesizer.visemeReceived = (_s, event) => {
      // audioOffset 單位為 100ns ticks，需除以 10_000_000 才能轉成秒
      const timeInSeconds = Number(event.audioOffset) / 10_000_000;
      visemeTimeline.push({
        time: Number(timeInSeconds.toFixed(3)),
        visemeId: event.visemeId // 若需轉嘴型名稱可在前端加一層 mapping
      });
    };

    const result = await new Promise((resolve, reject) => {
      synthesizer.speakTextAsync(
        text,
        (speechResult) => {
          if (speechResult.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve(speechResult);
          } else {
            reject(new Error(speechResult.errorDetails || '語音合成失敗'));
          }
          synthesizer.close(); // TTS 完成後需關閉資源
        },
        (error) => {
          synthesizer.close();
          reject(error);
        }
      );
    });

    const audioBuffer = Buffer.from(result.audioData);
    const audioBase64 = `data:audio/wav;base64,${audioBuffer.toString('base64')}`;

    return res.json({
      answer_text: text,
      audio_base64: audioBase64,
      visemes: visemeTimeline
    });
  } catch (error) {
    console.error('Azure Speech TTS 錯誤：', error);
    return res.status(500).json({ error: error.message || '語音合成失敗' });
  }
});

app.post('/api/did-talk', async (req, res) => {
  const { text, imageUrl, voiceId } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text 欄位必須為非空字串' });
  }

  if (!DID_API_KEY || !DID_API_SECRET) {
    return res.status(500).json({ error: '尚未設定 D-ID API 金鑰' });
  }

  const sourceUrl = (imageUrl && imageUrl.trim()) || DID_SOURCE_URL;
  if (!sourceUrl) {
    return res.status(400).json({ error: '未提供 D-ID 圖片 URL，請在 .env 設定 DID_SOURCE_URL 或傳入 imageUrl' });
  }

  if (!isValidHttpUrl(sourceUrl)) {
    return res.status(400).json({ error: '圖片 URL 必須為可公開存取的 http(s) 位址' });
  }

  try {
    const authHeader = `Basic ${Buffer.from(`${DID_API_KEY}:${DID_API_SECRET}`).toString('base64')}`;
    const payload = {
      script: {
        type: 'text',
        provider: {
          type: DID_SCRIPT_PROVIDER,
          voice_id: voiceId || DID_VOICE_ID,
        },
        input: text,
      },
      source_url: sourceUrl,
      config: {
        result_format: 'mp4',
      },
    };

    const talkResp = await fetch('https://api.d-id.com/talks', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const talkData = await talkResp.json().catch(() => ({}));

    if (!talkResp.ok) {
      const errorMessage =
        talkData?.error?.message ||
        talkData?.message ||
        talkData?.detail ||
        (Array.isArray(talkData?.details) ? talkData.details.map((item) => item.message).filter(Boolean).join('\n') : null) ||
        (talkData && typeof talkData === 'object' ? JSON.stringify(talkData) : '建立 D-ID 任務失敗');
      console.error('D-ID 建立任務失敗：', talkData);
      return res.status(talkResp.status).json({ error: errorMessage || '建立 D-ID 任務失敗' });
    }

    if (!talkData.id) {
      throw new Error('D-ID 未回傳任務 ID');
    }

    const finalData = await pollDidTalk(talkData.id, authHeader);

    return res.json({
      talk_id: talkData.id,
      status: finalData.status,
      video_url: finalData.result_url,
      audio_url: finalData.audio_url || null,
      duration: finalData.duration || null,
    });
  } catch (error) {
    console.error('D-ID API 錯誤：', error);
    return res.status(500).json({ error: error.message || 'D-ID 任務執行失敗' });
  }
});

// Export app for Vercel
export default app;

// Only start server if run directly (local development)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Azure TTS + Viseme demo server listening at http://localhost:${PORT}`);
  });
}
