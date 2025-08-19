import * as THREE from "three";
import { PlayerControls } from "./controls.js";

// Random colors for player avatars - pastel colors
const COLORS = [
  "#FF9AA2", // Pastel red
  "#FFB7B2", // Pastel salmon
  "#FFDAC1", // Pastel orange
  "#E2F0CB", // Pastel green
  "#B5EAD7", // Pastel mint
  "#C7CEEA", // Pastel blue
  "#F2D5F8", // Pastel purple
  "#FDFFB6"  // Pastel yellow
];

// Simple seeded random number generator
class MathRandom {
  constructor(seed) {
    this.seed = seed;
  }
  
  random() {
    const x = Math.sin(this.seed++) * 10000;
    return x - Math.floor(x);
  }
}

// Global variables for settings
let cubeCamera, groundMaterial;

async function main() {
  // Get username from Websim API if available, otherwise generate random name
  let playerName = `Player${Math.floor(Math.random() * 1000)}`;
  
  try {
    const user = await window.websim?.getUser();
    if (user && user.username) {
      playerName = user.username;
    }
  } catch (error) {
    console.log("Could not get websim user, using random name");
  }
  
  // Prepare menu sounds and enable after first user gesture
  const hoverSound = new Audio('/MenuButtonHovereffect.wav');
  const clickSound = new Audio('/menubuttonrollover.wav'); clickSound.volume = 1.0;
  let soundsUnlocked = false;
  const unlock = () => { soundsUnlocked = true; document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock);
  document.querySelectorAll('.menu button').forEach(btn => {
    btn.addEventListener('mouseenter', () => { if (!soundsUnlocked) return; hoverSound.currentTime = 0; hoverSound.volume = 0.6; hoverSound.play().catch(()=>{}); });
    btn.addEventListener('click', () => { if (!soundsUnlocked) return; clickSound.currentTime = 0; clickSound.play().catch(()=>{}); });
  });
  // Live online count on main menu via a pre-room
  const menuOnline = document.getElementById('menu-online');
  let preRoom = null;
  try {
    // Initialize preRoom in the background so buttons work immediately
    (async () => {
      preRoom = new WebsimSocket();
      await Promise.race([
        preRoom.initialize(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('menu preRoom timeout')), 2000))
      ]);
      const updateMenuOnline = () => { menuOnline.textContent = `Online: ${Object.keys(preRoom.presence || {}).length}`; };
      preRoom.subscribePresence(updateMenuOnline); updateMenuOnline();
    })().catch(() => { if (menuOnline) menuOnline.textContent = 'Online: —'; });
  } catch (e) {
    console.warn('Pre-room init failed:', e);
    if (menuOnline) menuOnline.textContent = 'Online: —';
  }
  
  // Interactive background for main menu
  const mainMenu = document.getElementById('main-menu');
  const lightEffect = document.getElementById('menu-background-light');
  if (mainMenu && lightEffect) {
    mainMenu.addEventListener('mousemove', (e) => {
      const rect = mainMenu.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      lightEffect.style.left = `${x}px`;
      lightEffect.style.top = `${y}px`;
    });
  }

  // Full map 'M' key listener
  const fullMapContainer = document.getElementById('full-map-container');

  // Defer starting until mode is chosen
  const chooseMode = () => new Promise((resolve) => {
    const mm = document.getElementById('main-menu');
    const sp = document.getElementById('singleplayer-btn');
    const mp = document.getElementById('multiplayer-btn');
    const ds = document.getElementById('demo-story-btn');
    const onClick = (mode) => {
      mm.style.display = 'none';
      if (soundsUnlocked) { clickSound.currentTime = 0; clickSound.play().catch(()=>{}); }
      resolve(mode);
    };
    sp.onclick = () => onClick('single');
    mp.onclick = () => onClick('multi');
    ds.onclick = () => onClick('demo');
  });
  const mode = await chooseMode();
  
  // Show minimap for backrooms mode
  if (mode !== 'demo') {
    const minimapContainer = document.getElementById('minimap-container');
    if (minimapContainer) minimapContainer.style.display = 'block';
  }

  // Fade in effect for game start
  const fadeOverlay = document.createElement('div');
  fadeOverlay.style.position = 'fixed';
  fadeOverlay.style.inset = '0';
  fadeOverlay.style.background = 'black';
  fadeOverlay.style.zIndex = '4000';
  fadeOverlay.style.opacity = '1';
  fadeOverlay.style.transition = 'opacity 1.5s ease-out';
  document.body.appendChild(fadeOverlay);
  setTimeout(() => { fadeOverlay.style.opacity = '0'; }, 100);
  setTimeout(() => { if(fadeOverlay.parentElement) fadeOverlay.parentElement.removeChild(fadeOverlay); }, 1600);

  // show gameplay-only UI now that a mode is chosen
  const staminaUI = document.getElementById('stamina');
  if (staminaUI) staminaUI.style.display = 'block';
  
  // Generate random HSL color for this player
  const hue = Math.floor(Math.random() * 360);
  const saturation = 70 + Math.floor(Math.random() * 30); // 70-100%
  const lightness = 50 + Math.floor(Math.random() * 30); // 50-80%
  const playerColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  
  // Safe initial position values with fallbacks
  const safePlayerX = (Math.random() * 10) - 5;
  const safePlayerZ = (Math.random() * 10) - 5;

  // Initialize WebsimSocket or local shim (reuse preRoom for multiplayer)
  const room = (mode === 'multi') ? (preRoom || new WebsimSocket()) : createLocalRoomShim();
  if (mode === 'multi' && room.initialize) {
    try { await room.initialize(); } catch(e){ console.warn('Room initialize failed:', e); }
  }

  // Use room creation time as a seed for RNG to sync maze & spawn for all players
  const roomSeed = room.roomState?.createdAt || Date.now();
  const mathRandom = new MathRandom(roomSeed);

  // Expose the current room globally so drawMinimap (called from PlayerControls) can access it
  window._GAME_ROOM = room;
  
  // Show loading overlay and setup loading manager
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  loadingOverlay.style.display = 'flex';
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => {
    const pct = Math.round((loaded / Math.max(total, 1)) * 100);
    loadingText.textContent = `Loading assets... ${pct}%`;
  };
  manager.onLoad = () => { loadingOverlay.style.display = 'none'; };
  
  // Setup Three.js scene
  const scene = new THREE.Scene();
  // Texture loader used throughout (define once to avoid ReferenceError)
  const loader = new THREE.TextureLoader(manager);
  
  let spawn = { x: 0, z: 0 }; // default spawn
  let totalWidth, totalDepth; // For ceiling dimensions
  
  if (mode === 'demo') {
    // DEMO MODE SETUP
    scene.background = new THREE.Color(0x101010); // Dark background for the room
    scene.fog = new THREE.Fog(0x101010, 5, 20);

    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const gltfLoader = new GLTFLoader(manager);
    
    // Load room, computer and add basic light
    const computerGltf = await gltfLoader.loadAsync('/old_computer_v2.glb');

    // Create a simple room since the GLB was missing walls/ceiling
    const roomGeo = new THREE.BoxGeometry(10, 6, 10);
    const roomMat = new THREE.MeshStandardMaterial({ color: 0x444444, side: THREE.BackSide, roughness: 0.8 });
    const roomMesh = new THREE.Mesh(roomGeo, roomMat);
    roomMesh.position.y = 3;
    roomMesh.receiveShadow = true;
    const demoContainer = new THREE.Group();
    demoContainer.position.y = 5; // Raise entire demo scene
    demoContainer.add(roomMesh);
    
    // Create a more realistic bed
    const bedGroup = new THREE.Group();
    const mattressGeo = new THREE.BoxGeometry(1.2, 0.4, 2.2);
    const mattressMat = new THREE.MeshStandardMaterial({ color: 0xeaeaea, roughness: 0.9 });
    const mattress = new THREE.Mesh(mattressGeo, mattressMat);
    mattress.position.y = 0.4;
    const frameGeo = new THREE.BoxGeometry(1.25, 0.2, 2.25);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x5a3825 });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.y = 0.1;
    bedGroup.add(mattress);
    bedGroup.add(frame);
    bedGroup.position.set(3, 0, -2);
    bedGroup.castShadow = true; bedGroup.receiveShadow = true;
    demoContainer.add(bedGroup);
    
    // Add invisible barrier for bed
    const bedBarrierGeo = new THREE.BoxGeometry(1.3, 2, 2.3);
    const transparentMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0, depthWrite: false});
    const bedBarrier = new THREE.Mesh(bedBarrierGeo, transparentMat);
    bedBarrier.position.set(3, 1, -2);
    bedBarrier.userData.isBarrier = true;
    demoContainer.add(bedBarrier);

    const tableGeo = new THREE.BoxGeometry(1.5, 0.8, 0.8);
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x966F33 });
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.set(-1.4, 0.4, -1.8);
    table.castShadow = true; table.receiveShadow = true;
    demoContainer.add(table);
    
    // Add invisible barrier for table
    const tableBarrier = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2, 0.9), transparentMat);
    tableBarrier.position.set(-1.4, 1, -1.8);
    tableBarrier.userData.isBarrier = true;
    demoContainer.add(tableBarrier);
    
    const computerScene = computerGltf.scene;
    computerScene.position.set(-1.4, 0.95, -1.8);
    computerScene.rotation.y = Math.PI / 1.5;
    computerScene.scale.set(0.6, 0.6, 0.6);
     computerScene.traverse(n => {
        if(n.isMesh) {
            n.castShadow = true;
        }
    });
    demoContainer.add(computerScene);
    
    // Add a warm light source from above
    const roomLight = new THREE.PointLight(0xffeedd, 1.0, 15, 1.5);
    roomLight.position.set(0, 4, 0);
    roomLight.castShadow = true;
    demoContainer.add(roomLight);

    // Add lightning effect
    const lightning = new THREE.DirectionalLight(0x88aaff, 0);
    lightning.position.set(20, 30, -30);
    demoContainer.add(lightning);
    scene.userData.lightning = lightning;

    scene.add(demoContainer);
    spawn = { x: 0.5, y: 5.5, z: 2 }; // Set spawn point inside the room, adjusting for new height

  } else {
    // BACKROOMS MODE (single/multiplayer)
    // Backrooms style: yellowed monochrome with fog
    const backroomsYellow = 0xE7D47A;
    scene.background = new THREE.Color(backroomsYellow);
    scene.fog = new THREE.FogExp2(backroomsYellow, 0.02);
    
    // Create maze and get open cells for spawning
    const cellSize = 3.5; // ensure a single defined cell size used everywhere
    const cols = 15, rows = 15;
    totalWidth = cols * cellSize;
    totalDepth = rows * cellSize;
    const { openCells, grid } = createBackroomsMaze(scene, cols, rows, cellSize, mathRandom);

    // Setup minimap data
    scene.userData.minimap = {
        grid,
        cols,
        rows,
        cellSize,
        revealed: Array.from({ length: rows }, () => Array(cols).fill(false)),
        needsUpdate: true
    };

    // Choose door location first so we can spawn far from it
    const doorCell = openCells.length ? openCells[Math.floor(mathRandom.random() * openCells.length)] : { x: 0, z: 0 };

    // Choose a spawn cell from open cells (center area bias)
    if (openCells && openCells.length > 0) {
      // Prefer cells far from the door to avoid spawning near it
      const farCells = openCells.filter(c => Math.hypot(c.x - doorCell.x, c.z - doorCell.z) > cellSize * 6);
      const candidates = farCells.length ? farCells : openCells;
      const chosen = candidates.reduce((best, c) => {
        const d = Math.hypot(c.x - doorCell.x, c.z - doorCell.z);
        return (!best || d > best.d) ? { c, d } : best;
      }, null)?.c || candidates[0];
      spawn = { x: chosen.x + (mathRandom.random() - 0.5) * 1.0, z: chosen.z + (mathRandom.random() - 0.5) * 1.0 };
    }

    // After maze creation, carve a real doorway in the east boundary and place door + neon room outside
    const eastX = (totalWidth/2) + cellSize/2;
    const doorWidth = 1.0, doorHeight = 2.2, doorThickness = 0.08;
    const eastCandidates = openCells.filter(c => c.x > totalWidth/2 - cellSize*1.5);
    const doorZ = (eastCandidates[0]?.z) ?? 0;
    // Find and replace the east boundary wall with a gap
    const eastWall = scene.children.find(m => m.userData?.isBarrier && Math.abs(m.position.x - eastX) < 0.01 && m.geometry?.parameters?.width === 1);
    if (eastWall) {
      const matRef = eastWall.material; scene.remove(eastWall);
      const gapHalf = (doorWidth + 0.4) / 2;
      const seg1 = new THREE.Mesh(new THREE.BoxGeometry(1, 3, (totalDepth/2) - gapHalf - Math.abs(doorZ)), matRef);
      seg1.position.set(eastX, 1.5, (doorZ + (-(totalDepth/2) + gapHalf))/2);
      const seg2 = new THREE.Mesh(new THREE.BoxGeometry(1, 3, (totalDepth/2) - gapHalf + Math.abs(doorZ)), matRef);
      seg2.position.set(eastX, 1.5, (doorZ + ((totalDepth/2) - gapHalf))/2);
      [seg1, seg2].forEach(s=>{ s.userData.isBarrier = true; s.castShadow=true; s.receiveShadow=true; scene.add(s); });
    }

    // Create a white objective door at the carved gap (hinge on left, opens right)
    const doorPivot = new THREE.Group();
    doorPivot.position.set(eastX - doorWidth/2, 0, doorZ);
    scene.add(doorPivot);
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(doorWidth, doorHeight, doorThickness),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.05 })
    );
    door.position.set(doorWidth/2, doorHeight/2, 0);
    door.userData.isDoor = true; door.userData.open = false; door.userData.isBarrier = true; door.name = "objectiveDoor";
    doorPivot.add(door);
    
    // Add a subtle light to the door to make it more visible
    const doorLight = new THREE.PointLight(0xffffff, 0.5, 5);
    doorLight.position.set(doorPivot.position.x, 1.5, doorPivot.position.z);
    scene.add(doorLight);

    // Place neon room OUTSIDE the maze, beyond east wall, aligned with the door
    const roomSize = 6;
    const roomMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
    const neonRoomWalls = new THREE.Group();
    neonRoomWalls.position.set(eastX + roomSize/2 + 0.7, 1.5, doorZ);
    scene.add(neonRoomWalls);
    
    const wallGeo = (w,d) => new THREE.BoxGeometry(w,3,d);
    const floor = new THREE.Mesh(wallGeo(roomSize, roomSize), new THREE.MeshStandardMaterial({color: 0x222222, roughness: 0.9}));
    floor.position.y = -1.5; floor.receiveShadow = true;
    const ceiling = new THREE.Mesh(wallGeo(roomSize, roomSize), new THREE.MeshStandardMaterial({color: 0x222222}));
    ceiling.position.y = 1.5;
    const wallB = new THREE.Mesh(wallGeo(roomSize, 0.1), roomMat); wallB.position.z = roomSize/2;
    const wallF = new THREE.Mesh(wallGeo(roomSize, 0.1), roomMat); wallF.position.z = -roomSize/2;
    const wallL = new THREE.Mesh(wallGeo(0.1, roomSize), roomMat); wallL.position.x = -roomSize/2;
    const wallR = new THREE.Mesh(wallGeo(0.1, roomSize), roomMat); wallR.position.x = roomSize/2;
    [floor, ceiling, wallB, wallF, wallL, wallR].forEach(m => neonRoomWalls.add(m));

    // Add a single spotlight in the end room
    const endLight = new THREE.SpotLight(0xffffff, 5.0, 10, Math.PI / 4, 0.5, 1.5);
    endLight.position.set(neonRoomWalls.position.x, 2.8, neonRoomWalls.position.z);
    endLight.target.position.set(neonRoomWalls.position.x, 0, neonRoomWalls.position.z);
    endLight.castShadow = true;
    scene.add(endLight);
    scene.add(endLight.target);
    
    // Add "Exit" sign above door
    const exitSignCanvas = document.createElement('canvas');
    exitSignCanvas.width = 256; exitSignCanvas.height = 128;
    const ctx = exitSignCanvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 256, 128);
    ctx.font = 'bold 70px Arial';
    ctx.fillStyle = '#ff4444';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EXIT', 128, 64);
    const exitSignTexture = new THREE.CanvasTexture(exitSignCanvas);
    const exitSignMaterial = new THREE.MeshBasicMaterial({ map: exitSignTexture });
    const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.5), exitSignMaterial);
    exitSign.position.set(eastX, doorHeight + 0.5, doorZ);
    scene.add(exitSign);
    
    // Place lamps and other maze-specific elements
    placeCeilingLamps(openCells);
    placeHintArrows(spawn, doorCell);
  }

  // Ambient fluorescent hum (looped low volume) using provided asset
  let bgHum = null;
  let masterVolume = 1.0; // new main/master volume multiplier
  try {
    if (mode !== 'demo') { // Only initialize and play hum in non-demo modes
      bgHum = new Audio('Fluorescent light Buzz.mp3');
      bgHum.loop = true;
      const initialBg = parseFloat(document.getElementById('bg-volume-slider')?.value || '0.03');
      bgHum.volume = initialBg * masterVolume;
      const tryPlay = () => { bgHum.play().catch(()=>{}); document.removeEventListener('pointerdown', tryPlay); };
      document.addEventListener('pointerdown', tryPlay);
    }
  } catch(e) { /* ignore */ }
   
  // Initialize renderer (was missing causing renderer is not defined)
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.physicallyCorrectLights = true;
  document.getElementById('game-container').appendChild(renderer.domElement);
  
  // Initialize player controls
  const playerControls = new PlayerControls(scene, room, {
    renderer: renderer,
    spawnPoint: { x: spawn.x, y: spawn.y || 0.5, z: spawn.z }
  });
  const camera = playerControls.getCamera();
  
  // Force camera and presence to spawn inside the maze (use spawn computed earlier)
  camera.position.set(spawn.x, (spawn.y || 0.5) + 1.0, spawn.z); // eye height above player center
  room.updatePresence({
    x: spawn.x,
    y: spawn.y || 0.5,
    z: spawn.z,
    quaternion: [0, 0, 0, 1],
    name: playerName,
    color: playerColor
  });
  
  // Ambient light darker; remove strong directional light
  const ambientLight = new THREE.AmbientLight(0xfff5c2, 0.05);
  scene.add(ambientLight);
  
  // Ground: replace material with textured carpet-like material and enable shadows
  const groundGeometry = new THREE.PlaneGeometry(200, 200);
  
  // Conditionally set floor texture based on mode
  const floorTexturePath = mode === 'demo' ? '/floor.jpg' : '/BackroomsFloorYellowCarpet.png';
  const floorTexture = loader.load(floorTexturePath);
  floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping;
  floorTexture.repeat.set(40, 40);
  groundMaterial = new THREE.MeshStandardMaterial({
    map: floorTexture,
    roughness: 1.0,
    metalness: 0.0
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2; // Rotate to horizontal
  ground.receiveShadow = true;
  scene.add(ground);
 
  // Ceiling: a large plane above with tiled ceiling texture for evenness
  if (mode !== 'demo') {
    const ceilingTexture = loader.load('ceiling.jpeg');
    ceilingTexture.wrapS = ceilingTexture.wrapT = THREE.RepeatWrapping;
    ceilingTexture.repeat.set(15, 15);
    const ceilingMat = new THREE.MeshStandardMaterial({ map: ceilingTexture, roughness: 1.0 });
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(totalWidth + 50, totalDepth + 50), ceilingMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = 4.5; // Raised from 3.1 to match higher walls
    ceiling.receiveShadow = true;
    scene.add(ceiling);
  }

  // Setup for Ultra Graphics Reflection
  const cubeRenderTarget = new THREE.WebGLCubeRenderTarget( 256 );
  cubeCamera = new THREE.CubeCamera( 1, 1000, cubeRenderTarget );
  scene.add(cubeCamera);
 
  // Update online users count on presence change
  const onlineUsers = document.querySelector("#online-users");
  const onlineCount = document.querySelector("#online-count");
  const onlineList = document.querySelector("#online-list");

  const updateOnline = () => {
    const p = room.presence || {};
    const count = Object.keys(p).length;
    if(onlineCount) onlineCount.textContent = `Online: ${count}`;
    
    if (onlineList && room.peers) {
        onlineList.innerHTML = ''; // Clear previous list
        for (const clientId in p) {
            if (room.peers[clientId]) {
                const li = document.createElement('li');
                li.textContent = room.peers[clientId].username;
                onlineList.appendChild(li);
            }
        }
    }
  };
  
  // Map to store player objects in the scene
  const playerObjects = new Map();
  // Animation mixers for GLB models
  const mixers = new Map();

  // Load animated avatar model
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const gltfLoader = new GLTFLoader(manager);
  let avatarGltf = null;
  try {
    avatarGltf = await gltfLoader.loadAsync('/r6_roblox_noob_animated.glb');
  } catch(e) {
    console.warn("Could not load avatar GLB, will use fallback.", e);
  }

  // Load NPC and place in end room if it exists
  const neonRoomWalls = scene.children.find(c => c.children.length === 6); // hacky way to find the group
  if (avatarGltf && neonRoomWalls) {
    const npc = avatarGltf.scene.clone();
    npc.scale.set(0.8, 0.8, 0.8); // Use smaller scale
    npc.position.set(neonRoomWalls.position.x, 0, neonRoomWalls.position.z);
    npc.rotation.y = Math.PI; // Face the player
    npc.traverse(c => { if(c.isMesh) c.castShadow = true; });
    npc.userData.isNpc = true;
    scene.add(npc);

    const mixer = new THREE.AnimationMixer(npc);
    const idleAction = mixer.clipAction(avatarGltf.animations.find(a => a.name.toLowerCase().includes('idle')));
    if (idleAction) idleAction.play();
    mixers.set('npc', { mixer, actions: { idle: idleAction }, lastAction: 'idle' });
  }

  // First-person limbs (local only)
  const fp = { phase: 0, parts: null };
  function createStickman(color='#ffffff') {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
    const limbGeo = new THREE.CapsuleGeometry(0.06, 0.6, 4, 8);
    const armL = new THREE.Mesh(limbGeo, mat); armL.position.set(0.25, 0.9, 0);
    const armR = new THREE.Mesh(limbGeo, mat); armR.position.set(-0.25, 0.9, 0);
    const legL = new THREE.Mesh(limbGeo, mat); legL.position.set(0.15, 0.2, 0);
    const legR = new THREE.Mesh(limbGeo, mat); legR.position.set(-0.15, 0.2, 0);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.8, 6, 12), mat); torso.position.set(0, 0.7, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), mat); head.position.set(0, 1.4, 0); head.name='head';
    // simple face
    const face = new THREE.CanvasTexture((() => { const c=document.createElement('canvas'); c.width=64; c.height=64; const ctx=c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,64,64); ctx.fillStyle='#000'; ctx.beginPath(); ctx.arc(22,24,5,0,Math.PI*2); ctx.arc(42,24,5,0,Math.PI*2); ctx.fill(); ctx.lineWidth=4; ctx.beginPath(); ctx.arc(32,40,10,0,Math.PI,false); ctx.stroke(); return c; })());
    head.material = new THREE.MeshStandardMaterial({ color, roughness:0.7, metalness:0.1, map: face });
    [armL, armR, legL, legR, torso, head].forEach(m=>{ m.castShadow=true; group.add(m); });
    group.userData.parts = { armL, armR, legL, legR, head };
    return group;
  }
  function addFirstPersonLimbs() {
    if (!avatarGltf) return;
    const fpModel = avatarGltf.scene.clone();
    fpModel.name = 'fpLimbs';
    // Set layer 1 for first-person model, and make camera see layer 1
    fpModel.traverse(child => {
      if (child.isMesh) {
        child.layers.set(1);
        child.frustumCulled = false; // Always render
      }
    });
    fpModel.scale.set(1.0, 1.0, 1.0); // Use 1.0 scale
    fpModel.position.set(0, -1.6, -0.5); // Adjusted position to be more visible
    camera.add(fpModel);
    camera.layers.enable(1); // Make sure camera can see layer 1

    const mixer = new THREE.AnimationMixer(fpModel);
    const idleAction = mixer.clipAction(avatarGltf.animations.find(a => a.name.toLowerCase().includes('idle')));
    const walkAction = mixer.clipAction(avatarGltf.animations.find(a => a.name.toLowerCase().includes('walk')));
    const jumpAction = mixer.clipAction(avatarGltf.animations.find(a => a.name.toLowerCase().includes('jump')));
    if (jumpAction) {
        jumpAction.setLoop(THREE.LoopOnce);
        jumpAction.clampWhenFinished = true;
    }
    
    fp.mixer = mixer;
    fp.actions = { idle: idleAction, walk: walkAction, jump: jumpAction };
    fp.lastAction = idleAction;
    fp.model = fpModel; // This was missing, bug fix for 'j' animation

    // Initially play idle animation
    if(idleAction) idleAction.play();
  }

  // Attach first-person limbs so you can see your hands/legs when looking down
  addFirstPersonLimbs();

  function removePlayerObject(connectionId) {
    const playerObj = playerObjects.get(connectionId);
    if (playerObj) {
      scene.remove(playerObj);
      playerObjects.delete(connectionId);
    }
  }

  function updatePlayerObject(user) {
    if (!user || !user.presence) return;
    const { presence, id } = user;
    if (!presence || !id) return;
    
    const safePresence = {
      x: 0, y: 0.5, color: '#FFFFFF', name: 'Unknown', walking: false,
      quaternion: [0, 0, 0, 1], ...presence
    };
    
    let playerObj = playerObjects.get(id);
    
    if (!playerObj) {
        if (id === room.clientId) {
            // This is the local player. We don't render a full model,
            // because we have a first-person view.
            // Create a placeholder group so the logic doesn't break.
            const holder = new THREE.Group(); 
            holder.userData.id = id;
            holder.visible = false;
            scene.add(holder);
            playerObjects.set(id, holder);
            playerObj = holder;
        } else {
            let group;
            if (avatarGltf) {
                group = avatarGltf.scene.clone();
                group.scale.set(1.0, 1.0, 1.0); // Use 1.0 scale
                group.traverse(child => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.layers.set(0); // Ensure it's on the default layer
                    }
                });
                // Setup animation mixer for this player
                const mixer = new THREE.AnimationMixer(group);
                const idleAction = mixer.clipAction(avatarGltf.animations.find(a => a.name.toLowerCase().includes('idle')));
                const walkAction = mixer.clipAction(avatarGltf.animations.find(a => a.name.toLowerCase().includes('walk')));
                if (idleAction) idleAction.play();
                mixers.set(id, { mixer, actions: { idle: idleAction, walk: walkAction }, lastAction: 'idle' });
            } else {
                group = createStickman(safePresence.color);
            }
            group.userData.id = id;

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = 256; canvas.height = 64;
            context.font = 'bold 24px Arial'; // Smaller font size
            context.textAlign = 'center'; context.textBaseline = 'middle';
            
            // Draw semi-transparent background
            context.fillStyle = 'rgba(0, 0, 0, 0.4)';
            const textMetrics = context.measureText(safePresence.name);
            const textWidth = textMetrics.width;
            const bgWidth = textWidth + 20;
            context.fillRect((canvas.width - bgWidth) / 2, (canvas.height - 32) / 2, bgWidth, 32);

            // Draw text
            context.fillStyle = 'white';
            context.strokeStyle = 'black'; context.lineWidth = 3;
            context.strokeText(safePresence.name, canvas.width/2, canvas.height/2);
            context.fillText(safePresence.name, canvas.width/2, canvas.height/2);
            
            const texture = new THREE.CanvasTexture(canvas);
            texture.minFilter = THREE.LinearFilter;
            const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: false });
            
            const nameSprite = new THREE.Sprite(spriteMaterial);
            nameSprite.scale.set(0.004 * canvas.width, 0.004 * canvas.height, 1);
            nameSprite.position.y = 1.9; nameSprite.name = "nameTag";
            group.add(nameSprite);
            
            scene.add(group);
            playerObjects.set(id, group);
            playerObj = group;
        }
    }
    
    if (playerObj && id !== room.clientId) {
      const nameTag = playerObj.getObjectByName("nameTag");
      if (nameTag && nameTag.material.map) {
        const currentName = safePresence.name;
        const canvas = nameTag.material.map.image;
        const context = canvas.getContext('2d');
        
        if (!nameTag.userData || nameTag.userData.currentName !== currentName) {
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.font = 'bold 24px Arial';
          context.textAlign = 'center'; context.textBaseline = 'middle';
          
          // Draw semi-transparent background
          context.fillStyle = 'rgba(0, 0, 0, 0.4)';
          const textMetrics = context.measureText(currentName);
          const textWidth = textMetrics.width;
          const bgWidth = textWidth + 20;
          context.fillRect((canvas.width - bgWidth) / 2, (canvas.height - 32) / 2, bgWidth, 32);

          // Draw text
          context.fillStyle = 'white';
          context.strokeStyle = 'black'; context.lineWidth = 3;
          context.strokeText(currentName, canvas.width/2, canvas.height/2);
          context.fillText(currentName, canvas.width/2, canvas.height/2);
          nameTag.material.map.needsUpdate = true;
          nameTag.userData = nameTag.userData || {};
          nameTag.userData.currentName = currentName;
        }
      }
    }

    if (playerObj) {
      playerObj.position.set(safePresence.x, safePresence.y, safePresence.z); // Adjust y to stand on ground
      const q = new THREE.Quaternion().fromArray(safePresence.quaternion);
      if (id !== room.clientId) {
        // Only apply YAW (horizontal) rotation to the body
        const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
        euler.x = 0; // Ignore pitch
        euler.z = 0; // Ignore roll
        playerObj.quaternion.setFromEuler(euler);
      }
      
      const nameTag = playerObj.getObjectByName("nameTag");
      if (nameTag) {
        // Make nametag always face the camera
        nameTag.quaternion.copy(camera.quaternion);
      }
      
      const animData = mixers.get(id);
      if (id !== room.clientId && animData) {
        const { actions, lastAction } = animData;
        const newAction = safePresence.walking ? 'walk' : 'idle';
        if (newAction !== lastAction && actions[newAction]) {
            if (actions[lastAction]) actions[lastAction].fadeOut(0.2);
            actions[newAction].reset().fadeIn(0.2).play();
            animData.lastAction = newAction;
        }
      } else if (id !== room.clientId && playerObj.userData?.parts) { // Fallback for stickman
        playerObj.userData.phase = (playerObj.userData.phase || 0) + (safePresence.walking ? 0.25 : 0.05);
        const amp = safePresence.walking ? 0.6 : 0.1;
        const s1 = Math.sin(playerObj.userData.phase) * amp;
        const s2 = Math.sin(playerObj.userData.phase + Math.PI) * amp;
        const { armL, armR, legL, legR } = playerObj.userData.parts;
        if (armL&&armR&&legL&&legR) {
          armL.rotation.x = s1; armR.rotation.x = s2;
          legL.rotation.x = s2; legR.rotation.x = s1;
        }
      }
    }
  }

  // Typing indicator via presence
  const typingIndicator = document.getElementById('typing-indicator');
  let typingTimeout = null;
  const bumpTyping = () => {
    if (mode !== 'multi') return;
    try { room.updatePresence({ typing: true }); } catch {}
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { try { room.updatePresence({ typing: false }); } catch {} }, 1500);
  };
  
  function updateTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    if (!el) return;
    const others = Object.entries(room.presence || {}).filter(([id, p]) => id !== room.clientId && p?.typing);
    if (others.length === 0) { el.textContent = ''; return; }
    if (others.length >= 3) { el.textContent = 'Many people are typing...'; return; }
    const names = others.map(([id]) => room.peers?.[id]?.username || 'Player');
    el.textContent = names.length === 1 ? `${names[0]} is typing...` : `${names[0]} and ${names[1]} are typing...`;
  };

  // Subscribe to presence changes and update online count
  room.subscribePresence((presence) => {
    updateOnline();
    Object.keys(presence).forEach(clientId => {
      if (presence[clientId]) {
        try {
          updatePlayerObject({ id: clientId, presence: presence[clientId] });
        } catch (e) {
          console.warn('updatePlayerObject error (ignored):', e);
        }
      }
    });
    playerObjects.forEach((obj, connectionId) => {
      if (!presence[connectionId]) {
        removePlayerObject(connectionId);
      }
    });
    updateTypingIndicator();
    // Force minimap/map redraw on any presence update to show other players moving
    if (scene.userData.minimap) {
        scene.userData.minimap.needsUpdate = true;
    }
  });

  // --- UI and Settings Logic ---
  const escapeMenu = document.getElementById('escape-menu');
  const settingsMenu = document.getElementById('settings-menu');
  const resetButton = document.getElementById('reset-button');
  const settingsButton = document.getElementById('settings-button');
  const closeMenuButton = document.getElementById('close-menu-button');
  const backButton = document.getElementById('back-button');
  const bgVolumeSlider = document.getElementById('bg-volume-slider');
  const walkVolumeSlider = document.getElementById('walk-volume-slider');
  const fovSlider = document.getElementById('fov-slider');
  const resolutionSlider = document.getElementById('resolution-slider');
  const resolutionReadout = document.getElementById('resolution-readout');
  const fovReadout = document.getElementById('fov-readout');
  const chatInput = document.getElementById('chat-input');
  const mainMenu = document.getElementById('main-menu');

  // Unified keydown listener for menus and chat
  document.addEventListener('keydown', (e) => {
    const isChatOpen = chatInput.style.display === 'block';
    const isMainMenuVisible = mainMenu.style.display !== 'none';
    const isEscapeMenuOpen = escapeMenu.style.display === 'block';
    const isSettingsMenuOpen = settingsMenu.style.display === 'block';
    const anyMenuOpen = isEscapeMenuOpen || isSettingsMenuOpen;

    if (e.key === 'Tab') {
      e.preventDefault();
      if (isMainMenuVisible || isChatOpen) return;

      if (isSettingsMenuOpen) {
        settingsMenu.style.display = 'none';
        escapeMenu.style.display = 'block';
      } else if (isEscapeMenuOpen) {
        escapeMenu.style.display = 'none';
        if (playerControls?.controls && !playerControls.isMobile && !playerControls.controls.isLocked) {
          playerControls.controls.lock();
        }
      } else {
        escapeMenu.style.display = 'block';
        if (document.pointerLockElement) {
          document.exitPointerLock();
        }
      }
    }

    if (e.key === 'Enter') {
      if (!isChatOpen && !anyMenuOpen && !isMainMenuVisible) {
        e.preventDefault();
        if (document.pointerLockElement) document.exitPointerLock();
        chatInput.style.display = 'block';
        chatInput.focus();
      }
    }
  });

  // Menu navigation
  settingsButton.addEventListener('click', () => {
    escapeMenu.style.display = 'none';
    settingsMenu.style.display = 'block';
  });

  closeMenuButton.addEventListener('click', () => {
    escapeMenu.style.display = 'none';
    if (playerControls?.controls && !playerControls.isMobile) {
      playerControls.controls.lock();
    }
  });

  backButton.addEventListener('click', () => {
    settingsMenu.style.display = 'none';
    escapeMenu.style.display = 'block';
  });

  resetButton.addEventListener('click', () => {
    if (bgHum) {
        bgHum.pause();
        bgHum.currentTime = 0;
    }
    // Back to main menu
    document.getElementById('main-menu').style.display = 'block';
    escapeMenu.style.display = 'none';
    settingsMenu.style.display = 'none';
    // A simple way back to a clean state:
    window.location.reload();
  });

  // Background volume controls
  if (bgVolumeSlider) {
    bgVolumeSlider.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (bgHum) bgHum.volume = v * masterVolume; // direct 0..1 mapping
    });
    // initialize mapped volume to current slider value
    if (bgHum) bgHum.volume = parseFloat(bgVolumeSlider.value) * masterVolume;
  }

  // Walking volume controls (affect local PlayerControls walking sound)
  if (walkVolumeSlider) {
    walkVolumeSlider.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      // PlayerControls exposes setWalkingVolume
      if (playerControls && typeof playerControls.setWalkingVolume === 'function') {
        playerControls.setWalkingVolume(v * masterVolume);
      } else {
        // fallback: try direct access to walkingSound
        if (playerControls && playerControls.walkingSound) playerControls.walkingSound.volume = v * masterVolume;
      }
    });
  }

  // NEW: Master volume slider hookup
  const masterVolumeSlider = document.getElementById('master-volume-slider');
  if (masterVolumeSlider) {
    masterVolumeSlider.addEventListener('input', (e) => {
      masterVolume = parseFloat(e.target.value);
      if (bgVolumeSlider && bgHum) {
        bgHum.volume = parseFloat(bgVolumeSlider.value) * masterVolume;
      }
      if (walkVolumeSlider && playerControls) {
        const wv = parseFloat(walkVolumeSlider.value);
        if (typeof playerControls.setWalkingVolume === 'function') {
          playerControls.setWalkingVolume(wv * masterVolume);
        } else if (playerControls.walkingSound) {
          playerControls.walkingSound.volume = wv * masterVolume;
        }
      }
    });
  }

  // FPS limiter controls
  const fpsSlider = document.getElementById('fps-slider');
  const fpsReadout = document.getElementById('fps-readout');
  let targetFPS = parseInt(fpsSlider?.value || '60', 10);
  fpsSlider?.addEventListener('input', (e) => { targetFPS = parseInt(e.target.value, 10); if (fpsReadout) fpsReadout.textContent = `FPS: ${targetFPS}`; });
  
  // Global FPS counter (works in menu and in-game)
  const fpsEl = document.getElementById('fps-counter');
  let fpsLast = performance.now(), fpsFrames = 0, fpsValue = 0;
  function tickFPS() {
    const now = performance.now(); fpsFrames++;
    if (now - fpsLast >= 1000) { fpsValue = fpsFrames; fpsFrames = 0; fpsLast = now; if (fpsEl) fpsEl.textContent = `FPS: ${fpsValue}`; }
    requestAnimationFrame(tickFPS);
  }
  tickFPS();

  // Settings controls
  fovSlider.addEventListener('input', (e) => {
    const fov = parseInt(e.target.value, 10);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    if(fovReadout) fovReadout.textContent = fov;
  });

  resolutionSlider.addEventListener('input', (e) => {
    const scale = parseFloat(e.target.value);
    renderer.setPixelRatio(window.devicePixelRatio * scale);
    if(resolutionReadout) resolutionReadout.textContent = `${Math.round(scale * 100)}%`;
  });

  const graphicsButtons = document.querySelectorAll('.graphics-option');
  graphicsButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      const quality = e.target.dataset.quality;
      setGraphicsQuality(quality);
      graphicsButtons.forEach(btn => btn.classList.remove('active'));
      e.target.classList.add('active');
    });
  });

  function setGraphicsQuality(quality) {
    switch(quality) {
      case 'low':
        renderer.shadowMap.enabled = false;
        groundMaterial.envMap = null;
        groundMaterial.needsUpdate = true;
        break;
      case 'medium':
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap; // Medium quality shadows
        groundMaterial.envMap = null;
        if(scene.userData.texturedWallMat) scene.userData.texturedWallMat.envMap = null;
        groundMaterial.needsUpdate = true;
        if(scene.userData.texturedWallMat) scene.userData.texturedWallMat.needsUpdate = true;
        break;
      case 'high':
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap; // High quality soft shadows
        groundMaterial.envMap = null;
        if(scene.userData.texturedWallMat) scene.userData.texturedWallMat.envMap = null;
        groundMaterial.needsUpdate = true;
        if(scene.userData.texturedWallMat) scene.userData.texturedWallMat.needsUpdate = true;
        break;
      case 'ultra':
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        groundMaterial.envMap = cubeRenderTarget.texture;
        if(scene.userData.texturedWallMat) scene.userData.texturedWallMat.envMap = cubeRenderTarget.texture;
        groundMaterial.needsUpdate = true;
        if(scene.userData.texturedWallMat) scene.userData.texturedWallMat.needsUpdate = true;
        break;
    }
  }
  // Set default graphics to medium
  setGraphicsQuality('medium');
  document.querySelector('.graphics-option[data-quality="medium"]').classList.add('active');

  // Load ceiling lamp GLB and place only inside maze open cells
  async function placeCeilingLamps(openCells) {
    try {
      const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
      const gltfLoader = new GLTFLoader(manager);
      const lampGltf = await new Promise((res, rej) => {
        gltfLoader.load('light_ceiling_lamp_-_15mb.glb', res, undefined, rej);
      });
      const lampScene = lampGltf.scene || lampGltf.scenes?.[0];
      if (!lampScene) return;

      // Make a single lamp prototype and clone it when placing
      lampScene.traverse(n => {
        if (n.isMesh) {
          n.castShadow = true;
          n.receiveShadow = true;
          // Make lamp bodies slightly emissive so they are visibly lit
          if (n.material && n.material.isMeshStandardMaterial) {
            n.material.metalness = n.material.metalness ?? 0.3;
            n.material.roughness = n.material.roughness ?? 0.4;
            // subtle emissive tint so the lamp glows
            n.material.emissive = n.material.emissive || new THREE.Color(0x222222);
            n.material.emissiveIntensity = n.material.emissiveIntensity ?? 0.6;
          }
        }
      });

      // Place lamps at every 2nd open cell to reduce count, centered in cells
      let placed = 0;
      const flickerLights = []; // collect flicker-enabled lights
      for (let i = 0; i < openCells.length; i += 2) {
        const cell = openCells[i];
        const lamp = lampScene.clone(true);
        lamp.position.set(cell.x, 4.35, cell.z);
        lamp.userData.isLamp = true;
        scene.add(lamp);
        const point = new THREE.PointLight(0xfff5c2, 0.85, 4.0, 2.2);
        point.castShadow = false;
        point.position.set(lamp.position.x, lamp.position.y - 0.05, lamp.position.z);
        point.userData.baseIntensity = point.intensity;
        if (Math.random() < 0.25) { point.userData.flicker = true; flickerLights.push(point); }
        scene.add(point);
        placed++;
      }
      // attach flicker list to scene for animate loop
      scene.userData.flickerLights = flickerLights;
    } catch (err) {
      console.warn('Failed to load/place lamps', err);
    }
  }

  // Add blood-red arrow hints pointing toward the door
  function placeHintArrows(spawn, doorCell) {
    const createArrowTexture = () => {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const ctx = c.getContext('2d');
      ctx.clearRect(0,0,256,256);
      ctx.fillStyle = '#7a0000';
      ctx.strokeStyle = '#4d0000';
      ctx.lineWidth = 8;
      ctx.lineJoin = 'round';
      // Draw a rough arrow
      ctx.beginPath();
      ctx.moveTo(40, 200);
      ctx.lineTo(160, 200);
      ctx.lineTo(160, 150);
      ctx.lineTo(220, 220);
      ctx.lineTo(160, 290);
      ctx.lineTo(160, 240);
      ctx.lineTo(40, 240);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      return new THREE.CanvasTexture(c);
    };
    const arrowTex = createArrowTexture();
    arrowTex.wrapS = arrowTex.wrapT = THREE.ClampToEdgeWrapping;

    const makeArrow = (pos, lookAt) => {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.9),
        new THREE.MeshBasicMaterial({ map: arrowTex, transparent: true })
      );
      plane.position.set(pos.x, 1.4, pos.z);
      // Orient toward door
      plane.lookAt(new THREE.Vector3(lookAt.x, 1.4, lookAt.z));
      // Nudge off the wall (toward the corridor)
      const dir = new THREE.Vector3().subVectors(lookAt, pos).normalize();
      plane.position.addScaledVector(dir, -0.05);
      plane.userData.isHint = true;
      scene.add(plane);
    };

    // Place a few arrows along the path from spawn to door
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1);
      const pos = {
        x: spawn.x + (doorCell.x - spawn.x) * t + (Math.random() - 0.5) * 0.8,
        z: spawn.z + (doorCell.z - spawn.z) * t + (Math.random() - 0.5) * 0.8
      };
      makeArrow(pos, doorCell);
    }
  }

  // CHAT SYSTEM
  const chatBox = document.getElementById('chat-messages');
  
  function postChatMessage(text, author = 'Server', options = {}) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    if (options.asHTML) div.innerHTML = `${author}: ${text}`;
    else div.textContent = `${author}: ${text}`;
    chatBox.prepend(div);
    // keep only 5 newest messages fully visible; older ones fade immediately
    const msgs = Array.from(chatBox.children);
    msgs.slice(5).forEach(m => { if (!m.classList.contains('fade')) { m.classList.add('fade'); setTimeout(()=>m.remove(), 600); } });
    setTimeout(() => { div.classList.add('fade'); setTimeout(()=>div.remove(), 600); }, 10000);
  }

  // Handle typing, sending, and closing chat
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // Prevents game movement while typing
    if (e.key === 'Enter') {
      e.preventDefault();
      if (chatInput.value.trim()) {
        const msg = chatInput.value.trim();
        chatInput.value = '';
        if (mode === 'multi') room.send({ type: 'chat', text: msg, echo: true });
        else postChatMessage(msg, 'You');
      }
      chatInput.style.display = 'none';
      if (playerControls.controls && !playerControls.isMobile) playerControls.controls.lock();
    } else if (e.key === 'Escape') {
      chatInput.value = ''; // Clear input on escape
      chatInput.style.display = 'none';
      if (playerControls.controls && !playerControls.isMobile) playerControls.controls.lock();
    } else if (e.key === 'Tab') {
        e.preventDefault(); // Prevent tabbing out of the input
    }
  });
  
  chatInput.addEventListener('keyup', (e) => { e.stopPropagation(); });
  chatInput.addEventListener('input', bumpTyping);

  // Add key listener for full map toggle
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm') {
        const chatOpen = document.getElementById('chat-input')?.style.display === 'block';
        const anyMenuOpen = (document.getElementById('escape-menu')?.style.display === 'block') || (document.getElementById('settings-menu')?.style.display === 'block');
        if (chatOpen || anyMenuOpen) return;
        
        const fullMapContainer = document.getElementById('full-map-container');
        const isVisible = fullMapContainer.style.display === 'flex';
        fullMapContainer.style.display = isVisible ? 'none' : 'flex';

        if (!isVisible && scene.userData.minimap) {
            scene.userData.minimap.needsUpdate = true; // Force redraw when opening
            drawMinimap(scene);
        }
    }
  });

  if (mode === 'multi') {
    room.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'connected') {
        const uname = room.peers?.[data.clientId]?.username || 'Player';
        postChatMessage(`<span style="color:#FFEB3B">${uname}</span> has joined!`, 'Server', { asHTML: true });
      }
      if (data.type === 'disconnected') {
        const uname = data.username || 'Player'; // username is included in disconnect event
        postChatMessage(`<span style="color:#FFB74D">${uname}</span> has left.`, 'Server', { asHTML: true });
      }
      if (data.type === 'chat' && typeof data.text === 'string') {
        const uname = room.peers?.[data.clientId]?.username || 'Player';
        postChatMessage(data.text, uname);
      }
    };
  }

  // Update online users count on presence change
  if (mode !== 'multi') postChatMessage('Singleplayer started', 'Server');
  
  // Animation loop with FPS limiter
  let lastRender = 0;
  const clock = new THREE.Clock();
  function animate(now) {
    requestAnimationFrame(animate);
    const interval = 1000 / Math.max(1, targetFPS);
    lastRender = now;
    const delta = clock.getDelta();
    
    // Update animation mixers
    mixers.forEach(data => data.mixer.update(delta));
    if (fp.mixer) fp.mixer.update(delta);
    
    // Only update player controls if not in a menu
    const anyMenuOpen = (document.getElementById('escape-menu')?.style.display === 'block') || (document.getElementById('settings-menu')?.style.display === 'block');
    const chatOpen = document.getElementById('chat-input')?.style.display === 'block';

    if (!anyMenuOpen && !chatOpen) {
      playerControls.update();
    } else {
      // Still update hand physics even if movement is paused
      playerControls.update();
    }
    
    // Update reflections for Ultra graphics
    const isUltraMode = (groundMaterial && groundMaterial.envMap !== null);
    if (isUltraMode) {
      // Hide the floor from the cube camera so it doesn't reflect itself
      ground.visible = false;
      // Hide walls, boundary and ceiling so sun and behind-wall objects don't appear in envmap
      const hidden = [];
      scene.traverse((obj) => {
        if (!obj) return;
        // Hide barriers/walls/ceiling (they have isBarrier) but keep lamps (isLamp) visible
        if (obj.userData && obj.userData.isBarrier) {
          if (obj.visible) { hidden.push(obj); obj.visible = false; }
        }
        // hide ceiling mesh if exists (position approx 3.1)
        if (obj.geometry && Math.abs((obj.position?.y || 0) - 3.1) < 0.6 && obj.type === 'Mesh' && obj.visible && !obj.userData.isLamp) {
          hidden.push(obj); obj.visible = false;
        }
        // Also temporarily hide directional lights (they don't render to cubemap)
        if (obj.isDirectionalLight) {
          if (obj.visible !== false) { obj.userData._wasVisible = obj.visible; obj.visible = false; hidden.push(obj); }
        }
      });
      
      cubeCamera.position.copy(camera.position);
      cubeCamera.update(renderer, scene);
      
      // restore visibility
      hidden.forEach(o => {
        // restore directional light visibility property if stored
        if (o.isDirectionalLight && typeof o.userData._wasVisible !== 'undefined') {
          o.visible = o.userData._wasVisible;
          delete o.userData._wasVisible;
        } else {
          o.visible = true;
        }
      });
      ground.visible = true;
    }
    
    // Gentle flicker on a subset of lamps
    const fl = scene.userData?.flickerLights || [];
    const t = performance.now() * 0.001;
    for (const l of fl) {
      const n = Math.sin(t * (3 + (l.uuid.charCodeAt(0) % 5)) + (l.uuid.charCodeAt(1) % 10)) * 0.08;
      const r = (Math.random() - 0.5) * 0.02;
      l.intensity = Math.max(0.3, l.userData.baseIntensity * (0.92 + n + r));
    }
    
    // Lightning effect for demo mode
    if (scene.userData.lightning) {
        if (Math.random() < 0.005) { // Occasional flash
            scene.userData.lightning.intensity = 2 + Math.random() * 3;
        } else {
            scene.userData.lightning.intensity *= 0.95; // Rapid decay
        }
    }

    // Door opening animation (swing right ~90deg)
    const door = scene.getObjectByName("objectiveDoor");
    const doorPivot = door?.parent;
    if (door && door.userData.animOpen !== undefined && door.userData.animOpen < 1) {
      door.userData.animOpen = Math.min(1, door.userData.animOpen + 0.05);
      doorPivot.rotation.y = -Math.PI/2 * door.userData.animOpen;
      if (door.userData.animOpen > 0.3) door.userData.isBarrier = false;
    }
    
    // Check proximity to door
    if (door) {
      const px = door.position.x, pz = door.position.z, py = door.position.y;
      const dist = Math.hypot(camera.position.x - px, camera.position.z - pz);
      if (dist < 2.0) {
        this.nearDoor = door;
        // Show prompt UI: desktop shows small hint, mobile shows button
        if(this.isMobile) {
            const interactBtn = document.getElementById('interact-button');
            if(interactBtn) interactBtn.style.display = 'block';
        } else {
            if (!document.getElementById('open-prompt')) {
              const p = document.createElement('div');
              p.id = 'open-prompt';
              p.style.position = 'fixed';
              p.style.left = '50%';
              p.style.bottom = '80px';
              p.style.transform = 'translateX(-50%)';
              p.style.padding = '8px 12px';
              p.style.background = 'rgba(0,0,0,0.6)';
              p.style.color = '#fff';
              p.style.borderRadius = '8px';
              p.style.zIndex = 1001;
              p.style.fontFamily = 'Noto Sans, Arial, sans-serif';
              p.innerText = 'Press E to Open';
              document.body.appendChild(p);
            } else {
              document.getElementById('open-prompt').style.display = 'block';
            }
        }
      } else {
        if(this.isMobile) {
            const interactBtn = document.getElementById('interact-button');
            if(interactBtn) interactBtn.style.display = 'none';
        } else {
            if (document.getElementById('open-prompt')) document.getElementById('open-prompt').style.display = 'none';
        }
      }
    }
    
    // Animate first-person limbs (local)
    if (fp.actions && fp.actions.idle && fp.actions.walk) {
      const moving = playerControls.currentMove.length() > 0.001 && playerControls.canJump;
      const currentAction = moving ? fp.actions.walk : fp.actions.idle;
      const lastAction = fp.lastAction || fp.actions.idle;

      if (currentAction !== lastAction) {
          lastAction.fadeOut(0.2);
          currentAction.reset().fadeIn(0.2).play();
          fp.lastAction = currentAction;
      }
       // Jumping animation
      if (playerControls.justJumped && fp.actions.jump) {
        fp.actions.jump.reset().play();
        if (fp.lastAction) fp.lastAction.crossFadeTo(fp.actions.jump, 0.1, true);
        fp.lastAction = fp.actions.jump;
        playerControls.justJumped = false;
      }

      // "j" key hand animation
      if (playerControls.isJumpingJack) {
        if(fp.model) fp.model.position.y = -1.6 + Math.sin(performance.now() * 0.02) * 0.1;
      } else {
        if(fp.model) fp.model.position.y = -1.6; // Return to normal position
      }
    } else if (fp.parts) { // Fallback for stickman
      const moving = playerControls.currentMove.length() > 0.001 && playerControls.canJump;
      fp.phase += moving ? 0.22 : 0.06;
      const amp = moving ? 0.6 : 0.1;
      fp.parts.armL.rotation.x = Math.sin(fp.phase) * amp;
      fp.parts.armR.rotation.x = Math.sin(fp.phase + Math.PI) * amp;
      fp.parts.legL.rotation.x = Math.sin(fp.phase + Math.PI) * amp;
      fp.parts.legR.rotation.x = Math.sin(fp.phase) * amp;

      // "j" key hand animation
      if (playerControls.isJumpingJack) {
        fp.parts.armR.position.y = -0.7 + Math.sin(performance.now() * 0.02) * 0.1;
      } else {
        fp.parts.armR.position.y = -0.4; // Return to normal position
      }
    }
    
    // If NPC exists, check proximity
    const npc = scene.children.find(c => c.userData.isNpc);
    const me = room.presence[room.clientId];
    if (npc && me) {
      const playerPos = new THREE.Vector3(me.x, me.y, me.z);
      const dist = playerPos.distanceTo(npc.position);
      
      const promptId = 'npc-prompt';
      let promptEl = document.getElementById(promptId);
      
      if (dist < 2.5) {
        if (!promptEl) {
          promptEl = document.createElement('div');
          promptEl.id = promptId;
          
          Object.assign(promptEl.style, {
              position: 'fixed', left: '50%', bottom: '80px', transform: 'translateX(-50%)',
              padding: '8px 12px', background: 'rgba(0,0,0,0.6)', color: '#fff',
              borderRadius: '8px', zIndex: '1001', fontFamily: 'Noto Sans, Arial, sans-serif'
          });
          document.body.appendChild(promptEl);
        }
        
        const isMobile = playerControls?.isMobile;
        if(isMobile) {
            const interactBtn = document.getElementById('interact-button');
            if(interactBtn) interactBtn.style.display = 'block';
            promptEl.style.display = 'none'; // Don't show text prompt on mobile, just button
        } else {
            promptEl.innerText = 'Press E to talk';
            promptEl.style.display = 'block';
        }

        if (playerControls.keysPressed.has('e') && !npc.userData.triggered) {
          npc.userData.triggered = true; // Prevent re-triggering
          promptEl.style.display = 'none';
          if(isMobile) {
            const interactBtn = document.getElementById('interact-button');
            if(interactBtn && !playerControls.nearDoor) interactBtn.style.display = 'none';
          }

          const endScreen = document.getElementById('end-screen');
          const endText = document.getElementById('end-text');
          if (endScreen && endText) {
            endText.innerHTML = `???:<br>"You... shouldn't... be here..."`;
            endScreen.style.display = 'flex';
            
            setTimeout(() => {
              endText.textContent = 'The End.';
            }, 4000);
            
            setTimeout(() => {
              window.location.reload();
            }, 7000);
          }
        }
      } else if (promptEl) {
        promptEl.style.display = 'none';
        if(playerControls?.isMobile) {
            const interactBtn = document.getElementById('interact-button');
            if(interactBtn && !playerControls.nearDoor) interactBtn.style.display = 'none';
        }
      }
    
    renderer.render(scene, camera);
  }

  animate(0);
}

// Local singleplayer shim (minimal Room-compatible API)
function createLocalRoomShim() {
  const presence = {};
  const clientId = 'local';
  presence[clientId] = {};
  let presenceCb = null;
  return {
    clientId,
    presence,
    updatePresence(upd) {
      Object.assign(presence[clientId], upd);
      if (presenceCb) presenceCb(presence);
    },
    subscribePresence(cb) {
      presenceCb = cb;
      cb(presence);
      return () => { presenceCb = null; };
    },
    // no-ops to satisfy optional calls in singleplayer
    updateRoomState() {},
    subscribeRoomState() { return () => {}; },
    requestPresenceUpdate() {},
    send() {},
    onmessage: null,
    peers: { [clientId]: { username: 'You', avatarUrl: '' } }
  };
}

// Attach drawMinimap to window so PlayerControls can access it
window.drawMinimap = drawMinimap;

// Modify createBackroomsMaze to return an array of open cell centers for spawning
// Accept the scene as the first parameter so the function can add meshes to it
function createBackroomsMaze(scene, cols = 11, rows = 11, cellSize = 4, mathRandom = Math) {
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xC9B85A,
    roughness: 0.9,
    metalness: 0.05
  });

  const wallHeight = 5.0; // Increased from 4.0

  const grid = Array.from({ length: rows }, () => Array(cols).fill(false));
  const stack = [];
  const startR = Math.floor(rows/2);
  const startC = Math.floor(cols/2);
  grid[startR][startC] = true;
  stack.push([startR, startC]);

  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const neighbors = [];
    const dirs = [[-2,0],[2,0],[0,-2],[0,2]];
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !grid[nr][nc]) neighbors.push([nr, nc, dr, dc]);
    }
    if (neighbors.length === 0) {
      stack.pop();
    } else {
      const idx = Math.floor(mathRandom.random() * neighbors.length);
      const [nr, nc, dr, dc] = neighbors[idx];
      grid[nr][nc] = true;
      grid[r + dr/2][c + dc/2] = true;
      stack.push([nr, nc]);
    }
  }

  // Load textures (diffuse + normal) for more realism
  const loader = new THREE.TextureLoader();
  // Use the provided wallpaper for walls
  const wallTexture = loader.load('wallpaper.jpeg');
  const wallNormal = loader.load('ceiling.jpeg'); // reuse ceiling as light normal placeholder for subtle variation
  wallTexture.wrapS = wallTexture.wrapT = THREE.RepeatWrapping;
  wallNormal.wrapS = wallNormal.wrapT = THREE.RepeatWrapping;
  wallTexture.repeat.set(1, 1);
  wallNormal.repeat.set(1, 1);

  // Use textured material
  const texturedWallMat = new THREE.MeshStandardMaterial({
    map: wallTexture,
    normalMap: wallNormal,
    roughness: 0.95,
    metalness: 0.02
  });
  scene.userData.texturedWallMat = texturedWallMat;

  const openCells = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r][c]) {
        const wallGeo = new THREE.BoxGeometry(cellSize, wallHeight, cellSize);
        const wall = new THREE.Mesh(wallGeo, texturedWallMat);
        wall.position.x = (c - Math.floor(cols/2)) * cellSize;
        wall.position.z = (r - Math.floor(rows/2)) * cellSize;
        wall.position.y = wallHeight / 2;
        wall.castShadow = true;
        wall.receiveShadow = true;
        wall.userData.isBarrier = true;
        scene.add(wall);
      } else {
        // record center of open cell for potential spawn positions
        openCells.push({
          x: (c - Math.floor(cols/2)) * cellSize,
          z: (r - Math.floor(rows/2)) * cellSize
        });
      }
    }
  }

  // Outer boundary using textured walls
  const boundaryThickness = 1;
  const totalWidth = cols * cellSize;
  const totalDepth = rows * cellSize;
  const bounds = [
    { w: totalWidth + 2*cellSize, h: wallHeight, d: boundaryThickness, x: 0, z: -(totalDepth/2) - cellSize/2 },
    { w: totalWidth + 2*cellSize, h: wallHeight, d: boundaryThickness, x: 0, z: (totalDepth/2) + cellSize/2 },
    { w: boundaryThickness, h: wallHeight, d: totalDepth + 2*cellSize, x: -(totalWidth/2) - cellSize/2, z: 0 },
    { w: boundaryThickness, h: wallHeight, d: totalDepth + 2*cellSize, x: (totalWidth/2) + cellSize/2, z: 0 },
  ];
  bounds.forEach(b => {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d);
    const m = new THREE.Mesh(g, texturedWallMat);
    m.position.set(b.x, b.h/2, b.z);
    m.userData.isBarrier = true;
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  });

  return { openCells, grid };
}

// --- Minimap Logic ---
function drawMinimap(scene) {
    // Use the globally exposed room reference (set in main) to avoid scope issues
    const roomRef = window._GAME_ROOM;
    if (!roomRef) return; // nothing to draw if room isn't ready

    const minimapData = scene.userData.minimap;
    if (!minimapData || !minimapData.needsUpdate) return;

    const { grid, cols, rows, revealed } = minimapData;
    const miniCanvas = document.getElementById('minimap-canvas');
    const fullCanvas = document.getElementById('full-map-canvas');
    if (!miniCanvas || !fullCanvas) return;
    
    const miniCtx = miniCanvas.getContext('2d');
    const fullCtx = fullCanvas.getContext('2d');
    
    // Set canvas sizes based on grid if not already set
    const mapWidth = cols * 10;
    const mapHeight = rows * 10;
    if (fullCanvas.width !== mapWidth) {
      fullCanvas.width = mapWidth;
      fullCanvas.height = mapHeight;
    }
    
    // Function to draw map on a given context
    const drawOnContext = (ctx, canvas, showAll) => {
      const cellW = canvas.width / cols;
      const cellH = canvas.height / rows;
      
      ctx.fillStyle = '#1a1a1a'; // Dark background
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (showAll || revealed[r][c]) {
            if (grid[r][c]) { // Path
              ctx.fillStyle = '#555';
            } else { // Wall
              ctx.fillStyle = '#333';
            }
            ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
          }
        }
      }
      
      // Draw other players
      Object.values(roomRef.presence || {}).forEach(p => {
          if (!p || p === roomRef.presence[roomRef.clientId]) return;
          const { x, z } = p;
          const c = (x / minimapData.cellSize) + cols / 2;
          const r = (z / minimapData.cellSize) + rows / 2;
          // Ensure r and c are valid indices before checking revealed status
          const r_idx = Math.floor(r);
          const c_idx = Math.floor(c);
          if (showAll || (r_idx >= 0 && r_idx < rows && c_idx >= 0 && c_idx < cols && revealed[r_idx][c_idx])) {
              ctx.fillStyle = '#f9a825'; // Yellow for others
              ctx.beginPath();
              ctx.arc(c * cellW, r * cellH, cellW * 0.7, 0, 2 * Math.PI);
              ctx.fill();
          }
      });
      
      // Draw local player on top
      const me = roomRef.presence[roomRef.clientId];
      if (me) {
        const { x, z } = me;
        const playerC = (x / minimapData.cellSize) + cols / 2;
        const playerR = (z / minimapData.cellSize) + rows / 2;
        
        ctx.fillStyle = '#ffffff'; // White for local player
        ctx.beginPath();
        ctx.arc(playerC * cellW, playerR * cellH, cellW * 0.7, 0, 2 * Math.PI);
        ctx.fill();
      }
    };

    // Draw full map with fog of war
    drawOnContext(fullCtx, fullCanvas, false);

    // Draw minimap - a centered, non-zoomed view
    const me = roomRef.presence[roomRef.clientId];
    if (me) {
        const { x, z } = me;
        const playerC = (x / minimapData.cellSize) + cols / 2;
        const playerR = (z / minimapData.cellSize) + rows / 2;
        const cellW = fullCanvas.width / cols;
        const cellH = fullCanvas.height / rows;

        // Calculate the source viewbox on the full map canvas to center the player
        const srcX = (playerC * cellW) - (miniCanvas.width / 2);
        const srcY = (playerR * cellH) - (miniCanvas.height / 2);

        // Clear minimap and draw the relevant part of the full map
        miniCtx.fillStyle = '#1a1a1a';
        miniCtx.fillRect(0, 0, miniCanvas.width, miniCanvas.height);
        miniCtx.drawImage(fullCanvas, srcX, srcY, miniCanvas.width, miniCanvas.height, 0, 0, miniCanvas.width, miniCanvas.height);
    }
  
    minimapData.needsUpdate = false;
}

main().catch(console.error);