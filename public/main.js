const textInput = document.getElementById('text-input');
const speakBtn = document.getElementById('speak-btn');
const audioPlayer = document.getElementById('audio-player');
const visemeOutput = document.getElementById('viseme-output');

speakBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text) {
    alert('請輸入要合成的文字');
    return;
  }

  speakBtn.disabled = true;
  speakBtn.textContent = '產生中...';
  visemeOutput.textContent = '產生中，請稍候...';

  try {
    const response = await fetch('/api/tts-viseme', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || '無法完成語音合成');
    }

    const data = await response.json();
    console.log('原始文字：', data.answer_text);

    audioPlayer.src = data.audio_base64;
    audioPlayer.play().catch(() => {
      // ignore autoplay restrictions
    });

    visemeOutput.textContent = JSON.stringify(data.visemes, null, 2);
  } catch (error) {
    console.error('呼叫 TTS API 失敗：', error);
    visemeOutput.textContent = `發生錯誤：${error.message}`;
  } finally {
    speakBtn.disabled = false;
    speakBtn.textContent = '產生語音 + Viseme';
  }
});
