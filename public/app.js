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

// VRoid VRM 標準嘴型對應（Fcl_MTH_* 命名）
const visemeNameToShapeKey = {
  sil:  null,           // 靜音，嘴保持閉合
  aa:   'Fcl_MTH_A',   // あ — 大開口母音
  ee:   'Fcl_MTH_E',   // え — 半開母音
  ih:   'Fcl_MTH_I',   // い — 扁平嘴型
  oh:   'Fcl_MTH_O',   // お — 圓形開口
  ou:   'Fcl_MTH_U',   // う — 嘟嘴圓唇
  w:    'Fcl_MTH_U',   // 圓唇音，近似 U
  m:    null,           // 閉嘴音
  fv:   'Fcl_MTH_A',   // 唇齒音，嘴微開
  l:    'Fcl_MTH_I',   // 舌尖音，接近 I
  mbp:  null,           // 閉嘴音
  ch:   'Fcl_MTH_I',   // 塞擦音，齒縫
  th:   'Fcl_MTH_A',   // 齒間音，微開
  dh:   'Fcl_MTH_A',   // 有聲齒間音
  r:    'Fcl_MTH_U',   // 捲舌音，圓唇
  sx:   'Fcl_MTH_I',   // 嘶音，齒縫
  k:    'Fcl_MTH_A',   // 軟顎音，開口
  t:    'Fcl_MTH_I',   // 齒齦音
  dz:   'Fcl_MTH_I',   // 塞擦音
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
const testerContainer = document.getElementById('tester-container')
const resetTesterBtn = document.getElementById('reset-tester-btn')


let renderer
let scene
let camera
let controls
let faceRoot = null
let faceMesh = null
let visemeNameToIndex = {}
let isModelReady = false
let mixer = null
const clock = new THREE.Clock()

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
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 2.5

  controls = new OrbitControls(camera, canvas)
  controls.enableZoom = true
  controls.minDistance = 0.4
  controls.maxDistance = 5
  controls.enablePan = true
  controls.autoRotate = false
  controls.autoRotateSpeed = 0.4

  const ambientLight = new THREE.AmbientLight(0xffffff, 3)
  scene.add(ambientLight)

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x8888aa, 2)
  scene.add(hemiLight)

  const dirLight = new THREE.DirectionalLight(0xffffff, 3)
  dirLight.position.set(3, 4, 5)
  scene.add(dirLight)

  const fillLight = new THREE.DirectionalLight(0xffffff, 1.5)
  fillLight.position.set(-3, 2, -3)
  scene.add(fillLight)

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
  if (mixer) {
    mixer.stopAllAction()
    mixer = null
  }

  loader.load(
    modelUrl,
    (gltf) => {
      faceRoot = gltf.scene
      faceRoot.position.set(0, -0.35, 0) // 往下移動，把臉抬到畫面中央
      faceRoot.rotation.set(0, Math.PI, 0) // 讓人臉朝向相機
      faceRoot.scale.set(0.9, 0.9, 0.9) // 如需縮小或放大可調整此比例
      scene.add(faceRoot)

      // 播放模型內建動畫（idle 等）
      if (gltf.animations?.length) {
        mixer = new THREE.AnimationMixer(faceRoot)
        const idleClip = gltf.animations[0]
        const action = mixer.clipAction(idleClip)
        action.play()
        console.log('播放動畫：', idleClip.name, '，共', gltf.animations.length, '個 clip')
      }

      faceMesh = findMorphMesh(faceRoot)
      if (faceMesh?.morphTargetDictionary) {
        console.log('Morph targets:', Object.keys(faceMesh.morphTargetDictionary))

        const availableShapes = Object.keys(faceMesh.morphTargetDictionary)

        // 1. 載入儲存的設定（只套用當前模型有效的 shape key）
        loadSavedMapping(availableShapes)

        // 2. 建立 UI（顯示用）
        renderMappingUI(availableShapes)
        renderTesterUI(faceMesh.morphTargetDictionary)

        // 3. 直接依 visemeNameToShapeKey 建立 index，不從 UI 讀回（避免 UI 未選時蓋掉預設值）
        visemeNameToIndex = {}
        buildVisemeDictionary(faceMesh.morphTargetDictionary)

        resetAllMorphs()
        isModelReady = true
        const mappedCount = Object.values(visemeNameToShapeKey).filter(v => v && availableShapes.includes(v)).length
        console.log('Viseme index map:', visemeNameToIndex)
        setStatus(`模型就緒（找到 ${availableShapes.length} 個 morph，${mappedCount} 個 viseme 有對應）`)
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
  const candidates = []
  root.traverse((child) => {
    if (child.isMesh && child.morphTargetDictionary && Object.keys(child.morphTargetDictionary).length > 0) {
      candidates.push(child)
    }
  })
  if (!candidates.length) return null

  console.log('Morph mesh candidates:', candidates.map(c => `${c.name} (${Object.keys(c.morphTargetDictionary).length} morphs)`))

  // 優先：有 VRoid 嘴型 morph 的 mesh
  const vroidFace = candidates.find(c => c.morphTargetDictionary['Fcl_MTH_A'] !== undefined)
  if (vroidFace) return vroidFace

  // 次選：名稱含 face/head/mouth
  const byName = candidates.find(c => /face|head|mouth|facial/i.test(c.name))
  return byName || candidates[0]
}

// --- Dynamic Mapping UI Logic ---

function loadSavedMapping(availableShapes = []) {
  const saved = localStorage.getItem('viseme_mapping_config')
  if (!saved) return
  try {
    const parsed = JSON.parse(saved)
    Object.keys(parsed).forEach(key => {
      const value = parsed[key]
      // 只套用 null 或當前模型確實有的 shape key，避免舊設定汙染
      if (value === null || availableShapes.includes(value)) {
        visemeNameToShapeKey[key] = value
      }
    })
    console.log('已載入自訂 Viseme 設定')
  } catch (e) {
    console.error('讀取設定失敗', e)
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

  const visemeDesc = {
    sil:  '靜音／閉嘴',
    aa:   '阿 (Ah) — 開口母音',
    ee:   '欸 (Ee) — 前高母音',
    ih:   '依 (Ih) — 短前母音',
    oh:   '喔 (Oh) — 後圓母音',
    ou:   '嗚 (Ou) — 圓唇母音',
    w:    '唇圓音 (W)',
    m:    '閉嘴音 (M) — 嘴唇閉合',
    fv:   '唇齒音 (F/V)',
    l:    '舌尖音 (L)',
    mbp:  '閉嘴音 (M/B/P) — 嘴唇閉合',
    ch:   '塞擦音 (Ch/J)',
    th:   '齒間音 (Th)',
    dh:   '有聲齒間音 (Dh)',
    r:    '捲舌音 (R)',
    sx:   '嘶音 (S/Z)',
    k:    '軟顎音 (K/G)',
    t:    '齒齦音 (T/D)',
    dz:   '塞擦音 (Dz)',
  }

  uniqueVisemes.forEach(viseme => {
    const row = document.createElement('div')
    row.className = 'mapping-row'

    const label = document.createElement('label')
    const desc = visemeDesc[viseme] || ''
    label.innerHTML = `<strong>${viseme}</strong><span class="viseme-desc">${desc}</span>`

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

function renderTesterUI(dict) {
  if (!testerContainer) return
  testerContainer.innerHTML = ''

  Object.keys(dict).forEach(shapeName => {
    const row = document.createElement('div')
    row.className = 'mapping-row'

    const label = document.createElement('label')
    label.textContent = shapeName
    label.title = shapeName // tooltip

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = '1'
    slider.step = '0.01'
    slider.value = '0'
    slider.style.maxWidth = '100px'

    const valueDisplay = document.createElement('span')
    valueDisplay.textContent = '0.0'
    valueDisplay.style.marginLeft = '8px'
    valueDisplay.style.minWidth = '24px'
    valueDisplay.style.fontSize = '0.8rem'

    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value)
      valueDisplay.textContent = val.toFixed(1)

      const idx = dict[shapeName]
      if (faceMesh && faceMesh.morphTargetInfluences && idx !== undefined) {
        faceMesh.morphTargetInfluences[idx] = val
      }
    })

    row.appendChild(label)
    row.appendChild(slider)
    row.appendChild(valueDisplay)
    testerContainer.appendChild(row)
  })
}

function resetTester() {
  resetAllMorphs()
  if (testerContainer) {
    const sliders = testerContainer.querySelectorAll('input[type="range"]')
    sliders.forEach(s => { s.value = '0' })
    const displays = testerContainer.querySelectorAll('span')
    displays.forEach(d => { d.textContent = '0.0' })
  }
}

function saveMapping() {
  localStorage.setItem('viseme_mapping_config', JSON.stringify(visemeNameToShapeKey))
  alert('設定已儲存！下次載入頁面會自動套用。')
}

function resetMapping() {
  localStorage.removeItem('viseme_mapping_config')
  alert('已清除自訂設定，將使用 VRoid 預設對應。請重新整理頁面。')
}

// --------------------------------

function buildVisemeDictionary(dict) {
  // 1. 先把所有原始的 ShapeKey 名稱都放進去 (例如 'MouthOpen' -> 0)
  // 這樣 handleSpeak 即使直接傳 'MouthOpen' 進來也能找到 index
  Object.entries(dict).forEach(([key, index]) => {
    visemeNameToIndex[key] = index
  })

  // 2. 再根據設定檔，把抽象的 Viseme 名稱對應到 index (例如 'aa' -> 0)
  Object.keys(visemeNameToShapeKey).forEach(visemeName => {
    const targetShapeName = visemeNameToShapeKey[visemeName]
    if (targetShapeName && dict.hasOwnProperty(targetShapeName)) {
      visemeNameToIndex[visemeName] = dict[targetShapeName]
    }
  })
  console.log('Viseme Mapping Result:', visemeNameToIndex)
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
  } else {
    // null morphTarget = 閉嘴，重置嘴部 morph
    applyViseme(null)
  }
}

const MOUTH_SHAPE_KEYS = ['Fcl_MTH_A', 'Fcl_MTH_I', 'Fcl_MTH_U', 'Fcl_MTH_E', 'Fcl_MTH_O', 'Fcl_MTH_Close', 'MouthOpen']

function applyViseme(visemeName) {
  if (!faceMesh?.morphTargetInfluences) return
  const influences = faceMesh.morphTargetInfluences

  // 只重置嘴部相關 morph，不動眼睛等 mixer 控制的 morph
  MOUTH_SHAPE_KEYS.forEach(key => {
    const idx = faceMesh.morphTargetDictionary[key]
    if (idx !== undefined) influences[idx] = 0
  })

  const index = visemeNameToIndex[visemeName]
  if (index !== undefined) {
    influences[index] = 1
  }
}

function renderLoop() {
  requestAnimationFrame(renderLoop)
  const delta = clock.getDelta()
  mixer?.update(delta)
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
      const shapeKey = visemeNameToShapeKey[azureName] ?? null
      return {
        time: item.time,
        morphTarget: shapeKey,  // null = 閉嘴，不觸發任何 morph
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
document.getElementById('reset-mapping-btn')?.addEventListener('click', resetMapping)
modelUploadInput?.addEventListener('change', handleModelUpload)
resetTesterBtn?.addEventListener('click', resetTester)

