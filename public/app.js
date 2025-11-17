import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const TTS_ENDPOINT = '/api/tts-viseme'
const FACE_MODEL_URL = 'assets/face.glb' // 請將人臉 GLB 放在 public/assets/face.glb

// const visemeIdToName = {
//   0: 'sil',
//   1: 'aa',
//   2: 'aa',
//   3: 'ee',
//   4: 'ih',
//   5: 'oh',
//   6: 'ou',
//   7: 'w',
//   8: 'm',
//   9: 'fv',
//   10: 'l',
//   11: 'mbp',
//   12: 'sil',
// }



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

// 模型 shape key 對應（請依自己的 GLB 名稱調整）
const visemeNameToShapeKey = {
  sil: 'Fcl_MTH_Neutral',
  aa: 'Fcl_MTH_A',
  ee: 'Fcl_MTH_I',
  ih: 'Fcl_MTH_I',
  oh: 'Fcl_MTH_O',
  ou: 'Fcl_MTH_U',
  w: 'Fcl_MTH_U',
  m: 'Fcl_MTH_Neutral',
  fv: 'mouthFunnel',
  l: 'Fcl_MTH_E',
  mbp: 'Fcl_MTH_Neutral',
  ch: 'mouthFunnel',
  th: 'Fcl_MTH_E',
  dh: 'Fcl_MTH_E',
  r: 'Fcl_MTH_U',
  sx: 'Fcl_MTH_E',
  k: 'Fcl_MTH_O',
  t: 'Fcl_MTH_E',
  dz: 'Fcl_MTH_A',
}

const textInput = document.getElementById('text-input')
const speakBtn = document.getElementById('speak-btn')
const audioPlayer = document.getElementById('audio-player')
const visemeOutput = document.getElementById('viseme-output')
const statusText = document.getElementById('status-text')
const canvas = document.getElementById('scene-canvas')

let renderer
let scene
let camera
let controls
let faceRoot = null
let faceMesh = null
const visemeNameToIndex = {}
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

function loadFaceModel() {
  setStatus('載入人臉模型中…')
  loader.load(
    FACE_MODEL_URL,
    (gltf) => {
      faceRoot = gltf.scene
      faceRoot.position.set(0, -0.35, 0) // 往下移動，把臉抬到畫面中央
      faceRoot.rotation.set(0, Math.PI, 0) // 讓人臉朝向相機
      faceRoot.scale.set(0.9, 0.9, 0.9) // 如需縮小或放大可調整此比例
      scene.add(faceRoot)

      faceMesh = findMorphMesh(faceRoot)
      if (faceMesh?.morphTargetDictionary) {
        console.log('Morph targets:', Object.keys(faceMesh.morphTargetDictionary))
        buildVisemeDictionary(faceMesh.morphTargetDictionary)
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

function buildVisemeDictionary(dict) {
  Object.entries(dict).forEach(([key, index]) => {
    if (key.startsWith('viseme_')) {
      visemeNameToIndex[key.replace('viseme_', '')] = index
    }
    visemeNameToIndex[key] = index
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
    return
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
  if (!playing || !timeline.length || !faceMesh) return

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

  const visemeName = timeline[idx]?.name || 'sil'
  applyViseme(visemeName)
}

function applyViseme(visemeName) {
  if (!faceMesh?.morphTargetInfluences) return
  const influences = faceMesh.morphTargetInfluences
  influences.fill(0)
  const index =
    visemeNameToIndex[visemeName] ||
    visemeNameToIndex[`viseme_${visemeName}`] ||
    visemeNameToIndex.sil
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
        name: shapeKey,
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

initScene()
speakBtn.addEventListener('click', handleSpeak)
