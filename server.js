import express from 'express';
import dotenv from 'dotenv';
import sdk from 'microsoft-cognitiveservices-speech-sdk';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SPEECH_KEY = process.env.SPEECH_KEY;
const SPEECH_REGION = process.env.SPEECH_REGION;

if (!SPEECH_KEY || !SPEECH_REGION) {
  console.warn('\u26a0\ufe0f  未設定 SPEECH_KEY 或 SPEECH_REGION，請確認 .env 是否完成設定');
}

app.use(express.json());
app.use(express.static('public'));

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

app.listen(PORT, () => {
  console.log(`Azure TTS + Viseme demo server listening at http://localhost:${PORT}`);
});
