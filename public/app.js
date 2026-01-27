import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const DEFAULT_API_BASE = 'http://localhost:3000'

function normalizeBaseUrl(value) {
  if (!value) return ''
  return value.replace(/\/+$/, '')
}

function resolveApiBase() {
  if (typeof window === 'undefined') return DEFAULT_API_BASE
  const params = new URLSearchParams(window.location.search)
  const queryBase = params.get('apiBase')
  if (isValidHttpUrl(queryBase)) {
    return normalizeBaseUrl(queryBase)
  }

  const configBase = window.APP_CONFIG?.apiBase
  if (isValidHttpUrl(configBase)) {
    return normalizeBaseUrl(configBase)
  }

  const origin = window.location.origin || ''
  const protocol = window.location.protocol || ''
  if (origin.includes('localhost:3001') || origin.includes('127.0.0.1:3001') || protocol === 'file:') {
    return DEFAULT_API_BASE
  }
  if (origin.includes('localhost:3000') || origin.includes('127.0.0.1:3000')) {
    return ''
  }
  return ''
}

const API_BASE = resolveApiBase()
const withApiBase = (path) => `${API_BASE}${path}`

const TTS_ENDPOINT = withApiBase('/api/tts-viseme')

const FACE_MODEL_URL = 'assets/Principle.glb' // 請將人臉 GLB 放在 public/assets/

// ... (existing comments)

// Azure 官方 viseme ID → 名稱（保持原始定義，方便查表）
const azureVisemeNames = {
  0: 'sil',
  1: 'aa',
  2: 'aa',
  3: 'ee',
  4: 'ih',
  5: 'oh',
  6: 'ou',
  7: 'w',
  8: 'm',
  9: 'fv',
  10: 'l',
  11: 'mbp',
  12: 'sil',
  13: 'aa',
  14: 'ch',
  15: 'th',
  16: 'dh',
  17: 'r',
  18: 'sx',
  19: 'k',
  20: 't',
  21: 'dz',
}

// 模型 shape key 對應（修改為 Principle.glb 的單一 ShapeKey）
// 只有一個 'MouthOpen'，所以除了閉嘴音 (sil, m, mbp) 之外，全部對應到 'MouthOpen'
const visemeNameToShapeKey = {
  sil: null,
  aa: 'MouthOpen',
  ee: 'MouthOpen',
  ih: 'MouthOpen',
  oh: 'MouthOpen',
  ou: 'MouthOpen',
  w: 'MouthOpen',
  m: null, // 閉嘴
  fv: 'MouthOpen',
  l: 'MouthOpen',
  mbp: null, // 閉嘴
  ch: 'MouthOpen',
  th: 'MouthOpen',
  dh: 'MouthOpen',
  r: 'MouthOpen',
  sx: 'MouthOpen',
  k: 'MouthOpen',
  t: 'MouthOpen',
  dz: 'MouthOpen',
}

const textInput = document.getElementById('text-input')
const speakBtn = document.getElementById('speak-btn')
const audioPlayer = document.getElementById('audio-player')
const visemeOutput = document.getElementById('viseme-output')
const statusText = document.getElementById('status-text')

const canvas = document.getElementById('scene-canvas')
const mappingContainer = document.getElementById('mapping-container')
const modelMorphCountSpan = document.getElementById('model-morph-count')
const saveMappingBtn = document.getElementById('save-mapping-btn')
const modelUploadInput = document.getElementById('model-upload')


let renderer
let scene
let camera
let controls
let faceRoot = null
let faceMesh = null
let visemeNameToIndex = {}
let isModelReady = false

const lipsyncState = {
  timeline: [],
  currentIndex: 0,
  startTime: 0,
  audioDuration: 0,
  playing: false,
}

const loader = new GLTFLoader()

function setStatus(message) {
  statusText.textContent = message
}

function initScene() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x030303)

  const { clientWidth, clientHeight } = canvas

  camera = new THREE.PerspectiveCamera(35, clientWidth / clientHeight, 0.01, 20)
  camera.position.set(0, 0, 1.2)

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(clientWidth, clientHeight, false)

  controls = new OrbitControls(camera, canvas)
  controls.enableZoom = true
  controls.minDistance = 0.4
  controls.maxDistance = 2.5
  controls.enablePan = false
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.4

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x111122, 1.15)
  scene.add(hemiLight)

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
  dirLight.position.set(3, 4, 5)
  scene.add(dirLight)

  loadFaceModel()
  window.addEventListener('resize', onWindowResize)
  requestAnimationFrame(renderLoop)
}

function onWindowResize() {
  if (!renderer || !camera) return
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height, false)
}

function loadFaceModel(modelUrl = FACE_MODEL_URL) {
  setStatus('載入人臉模型中…')

  // Cleanup previous model
  if (faceRoot) {
    scene.remove(faceRoot)
    faceRoot = null
    faceMesh = null
    isModelReady = false
  }

  loader.load(
    modelUrl,
    (gltf) => {
      faceRoot = gltf.scene
      faceRoot.position.set(0, -0.35, 0) // 往下移動，把臉抬到畫面中央
      faceRoot.rotation.set(0, Math.PI, 0) // 讓人臉朝向相機
      faceRoot.scale.set(0.9, 0.9, 0.9) // 如需縮小或放大可調整此比例
      scene.add(faceRoot)

      faceMesh = findMorphMesh(faceRoot)
      if (faceMesh?.morphTargetDictionary) {
        console.log('Morph targets:', Object.keys(faceMesh.morphTargetDictionary))

        // 1. 先嘗試載入儲存的設定
        loadSavedMapping()

        // 2. 建立 UI
        renderMappingUI(Object.keys(faceMesh.morphTargetDictionary))

        // 3. 根據 UI 更新目前的 Mapping
        updateMappingFromUI()

        resetAllMorphs()
        isModelReady = true
        setStatus('模型就緒，請輸入文字。')
      } else {
        setStatus('模型缺少 morph target，請檢查 GLB。')
      }
    },
    undefined,
    (error) => {
      console.error('載入人臉 GLB 失敗：', error)
      setStatus('載入人臉 GLB 失敗，請查看 console。')
    }
  )
}

function findMorphMesh(root) {
  let target = null
  root.traverse((child) => {
    if (!target && child.isMesh && child.morphTargetDictionary) {
      target = child
    }
  })
  return target
}

// --- Dynamic Mapping UI Logic ---

function loadSavedMapping() {
  const saved = localStorage.getItem('viseme_mapping_config')
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      // 覆蓋目前的預設值
      Object.assign(visemeNameToShapeKey, parsed)
      console.log('已載入自訂 Viseme 設定')
    } catch (e) {
      console.error('讀取設定失敗', e)
    }
  }
}

function renderMappingUI(availableShapes) {
  if (!mappingContainer) return
  mappingContainer.innerHTML = ''

  if (modelMorphCountSpan) {
    modelMorphCountSpan.textContent = availableShapes.length
  }

  // 只列出需要設定的口型 (排除 null 的 sil 等，如果想讓使用者自訂 sil 也可以列出)
  // 這裡列出所有 azureVisemeNames 裡出現過的 unique values
  const uniqueVisemes = [...new Set(Object.values(azureVisemeNames))].sort()

  uniqueVisemes.forEach(viseme => {
    const row = document.createElement('div')
    row.className = 'mapping-row'

    const label = document.createElement('label')
    label.textContent = `${viseme}`

    // 加上簡單說明
    if (viseme === 'sil') label.textContent += ' (靜音/閉嘴)'
    else if (viseme === 'aa') label.textContent += ' (阿/Ah)'
    else if (viseme === 'ou') label.textContent += ' (嗚/Ou)'

    const select = document.createElement('select')
    select.dataset.viseme = viseme

    // Default option: None/Null
    const nullOption = document.createElement('option')
    nullOption.value = ''
    nullOption.textContent = '-- 無 --'
    select.appendChild(nullOption)

    availableShapes.forEach(shape => {
      const option = document.createElement('option')
      option.value = shape
      option.textContent = shape
      select.appendChild(option)
    })

    // Set current value
    const currentMap = visemeNameToShapeKey[viseme]
    if (currentMap && availableShapes.includes(currentMap)) {
      select.value = currentMap
    }

    // Event listener for real-time update
    select.addEventListener('change', () => {
      updateMappingFromUI()
    })

    row.appendChild(label)
    row.appendChild(select)
    mappingContainer.appendChild(row)
  })
}

function updateMappingFromUI() {
  if (!mappingContainer) return
  const selects = mappingContainer.querySelectorAll('select')
  selects.forEach(select => {
    const viseme = select.dataset.viseme
    const shape = select.value
    visemeNameToShapeKey[viseme] = shape || null
  })

  // Re-build dictionary using the NEW mapping
  if (faceMesh && faceMesh.morphTargetDictionary) {
    visemeNameToIndex = {} // clear old
    buildVisemeDictionary(faceMesh.morphTargetDictionary)
  }
}

function saveMapping() {
  localStorage.setItem('viseme_mapping_config', JSON.stringify(visemeNameToShapeKey))
  alert('設定已儲存！下次載入頁面會自動套用。')
}

// --------------------------------

function buildVisemeDictionary(dict) {
  // 原本的邏輯是直接拿 key map，現在我們要透過 visemeNameToShapeKey 做中介
  // 但為了效能，我們還是預先計算 visemeName -> index

  // 1. 為了相容 Azure 傳來的 visemeID，我們需要知道 'aa' 對應到哪個 GLB index
  // visemeNameToIndex['aa'] = 3 (例如)

  Object.keys(visemeNameToShapeKey).forEach(visemeName => {
    const targetShapeName = visemeNameToShapeKey[visemeName]
    if (targetShapeName && dict.hasOwnProperty(targetShapeName)) {
      visemeNameToIndex[visemeName] = dict[targetShapeName]
    }
  })
}

function resetAllMorphs() {
  if (!faceMesh?.morphTargetInfluences) return
  faceMesh.morphTargetInfluences.fill(0)
}

function stopLipsync() {
  lipsyncState.playing = false
  lipsyncState.timeline = []
  lipsyncState.currentIndex = 0
  lipsyncState.audioDuration = 0
  resetAllMorphs()
}

function startLipsync(timeline, audioDuration = 0) {
  if (!faceMesh) {
    console.warn('人臉模型尚未載入')
  }
  lipsyncState.timeline = timeline.slice()
  lipsyncState.currentIndex = 0
  lipsyncState.startTime = performance.now() / 1000
  lipsyncState.audioDuration = audioDuration
  lipsyncState.playing = true
  resetAllMorphs()
}

function updateLipsync() {
  const { timeline, playing } = lipsyncState
  if (!playing || !timeline.length) return

  const elapsed = performance.now() / 1000 - lipsyncState.startTime
  const lastTime = timeline[timeline.length - 1].time
  const endTime = Math.max(lastTime, lipsyncState.audioDuration || 0)

  if (elapsed >= endTime + 0.05) {
    stopLipsync()
    return
  }

  let idx = lipsyncState.currentIndex
  while (idx < timeline.length - 1 && timeline[idx + 1].time <= elapsed) {
    idx += 1
  }
  lipsyncState.currentIndex = idx

  const currentViseme = timeline[idx]
  if (currentViseme?.morphTarget) {
    applyViseme(currentViseme.morphTarget)
  }
}

function applyViseme(visemeName) {
  if (!faceMesh?.morphTargetInfluences) return
  const influences = faceMesh.morphTargetInfluences
  influences.fill(0)
  let index = visemeNameToIndex[visemeName]
  if (index === undefined) {
    index = visemeNameToIndex[`viseme_${visemeName}`]
  }
  if (index === undefined) {
    index = visemeNameToIndex.sil
  }

  if (index !== undefined) {
    influences[index] = 1
  }
}

function renderLoop() {
  requestAnimationFrame(renderLoop)
  controls?.update()
  updateLipsync()
  renderer?.render(scene, camera)
}



function isValidHttpUrl(value) {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch (error) {
    return false
  }
}



async function handleSpeak() {
  const text = textInput.value.trim()
  if (!text) {
    alert('請輸入要說的句子')
    return
  }
  if (!isModelReady || !faceMesh) {
    alert('模型尚未載入完成，請稍候')
    return
  }

  speakBtn.disabled = true
  setStatus('呼叫 Azure Speech Service 中…')
  visemeOutput.textContent = 'Viseme timeline 生成中…'

  try {
    const response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}))
      throw new Error(errorBody.error || 'TTS API 回傳錯誤')
    }

    const data = await response.json()
    const visemeTimeline = (data.visemes || []).map((item) => {
      const azureName = azureVisemeNames[item.visemeId]
      if (!azureName) {
        console.warn('未知的 Azure visemeId，退回靜音：', item.visemeId)
      }
      const shapeKey =
        visemeNameToShapeKey[azureName] ||
        visemeNameToShapeKey.sil ||
        'mouthClose'
      return {
        time: item.time,
        morphTarget: shapeKey,
      }
    })

    visemeOutput.textContent = JSON.stringify(visemeTimeline, null, 2)
    setStatus(`AI 說：「${data.answer_text || text}」`)

    if (!audioPlayer.dataset.bound) {
      audioPlayer.addEventListener('ended', stopLipsync)
      audioPlayer.dataset.bound = 'true'
    }

    audioPlayer.src = data.audio_base64
    audioPlayer.load()

    const startPlayback = () => {
      const duration = audioPlayer.duration || (visemeTimeline.at(-1)?.time ?? 0)
      if (visemeTimeline.length) {
        startLipsync(visemeTimeline, duration)
      } else {
        stopLipsync()
      }
      audioPlayer.play().catch((err) => {
        console.warn('音訊播放遭瀏覽器阻擋：', err)
      })
    }

    if (audioPlayer.readyState >= 1) {
      startPlayback()
    } else {
      audioPlayer.addEventListener('loadedmetadata', startPlayback, { once: true })
    }
  } catch (error) {
    console.error('呼叫 TTS API 失敗：', error)
    setStatus(`呼叫 TTS API 失敗：${error.message}`)
    visemeOutput.textContent = `發生錯誤：${error.message}`
    stopLipsync()
  } finally {
    speakBtn.disabled = false
  }
}



// --- Model Import Logic ---

function handleModelUpload(event) {
  const file = event.target.files[0]
  if (!file) return

  const blobUrl = URL.createObjectURL(file)
  console.log('Loading local model:', file.name)

  // Load new model
  loadFaceModel(blobUrl)

  // Reset file input so same file can be selected again
  event.target.value = ''
}


initScene()
speakBtn.addEventListener('click', handleSpeak)
saveMappingBtn?.addEventListener('click', saveMapping)
modelUploadInput?.addEventListener('change', handleModelUpload)

