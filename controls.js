import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Movement constants
const SPEED = 0.032; // Slower walking speed (was 0.027, increased by ~20%)
const GRAVITY = 0.008;
const JUMP_FORCE = 0.15; // Higher jump force (was 0.12)
const CROUCH_SPEED_MULTIPLIER = 0.6;

// Player height constants
const STANDING_HEIGHT = 1.6;
const CROUCHING_HEIGHT = 1.0;
const STANDING_CAM_Y_OFFSET = 1.0;
const CROUCHING_CAM_Y_OFFSET = 0.6;
const CROUCH_TRANSITION_SPEED = 0.1;

export class PlayerControls {
  constructor(scene, room, options = {}) {
    this.scene = scene;
    this.room = room;
    this.camera = options.camera || new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.renderer = options.renderer;
    this.domElement = this.renderer ? this.renderer.domElement : document.body;
    this.spawnPoint = options.spawnPoint || { x: 0, y: 0.5, z: 0 };
    
    // Player state
    this.velocity = new THREE.Vector3();
    this.canJump = true;
    this.keysPressed = new Set();
    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    this.isCrouching = false;
    this.isSprinting = false;
    this.stamina = 100; this.lastUpdateTime = performance.now();
    this.STAMINA_MAX = 100; this.SPRINT_MULT = 2.0; this.STAMINA_DRAIN = 20; this.STAMINA_REGEN = 15;
    this.currentCamYOffset = STANDING_CAM_Y_OFFSET;
    this.isJumpingJack = false; // For the 'j' key animation
    this.justJumped = false;
    
    // Mobile control variables
    this.joystick = null;
    this.touchStartX = 0;
    this.touchStartY = 0;
    this.touchSensitivity = 0.005;
    this.moveVector = new THREE.Vector3(0,0,0);
    this.jumpButtonPressed = false;
    
    // Smooth movement + headbob
    this.currentMove = new THREE.Vector3(0, 0, 0);
    this.bobTime = 0;
    // Spring physics for hands
    this.handState = {
      target: new THREE.Vector3(),
      current: new THREE.Vector3(),
      velocity: new THREE.Vector3()
    };
    
    // UI for door interaction
    this.openPrompt = null;
    this.openButton = null;
    this.nearDoor = null;
    
    // Set initial player position from spawn point
    this.playerX = this.spawnPoint.x;
    this.playerY = this.spawnPoint.y;
    this.playerZ = this.spawnPoint.z;
    
    // Set initial camera position
    this.camera.position.set(this.playerX, this.playerY + STANDING_CAM_Y_OFFSET, this.playerZ);
    
    // Create audio for jump sound
    this.jumpSound = new Audio('/Wood_jump3.wav.mp3');
    this.jumpSound.volume = 0.5; // Set volume to 50%
    
    // Create audio for walking sound
    this.walkingSound = new Audio('/Walking.mp3');
    this.walkingSound.loop = true;
    this.walkingSound.volume = 0.5;
    this.isWalkingSoundPlaying = false;
    
    // Initialize controls based on device
    this.initializeControls();
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Stamina UI cache
    this.staminaLabel = document.querySelector('#stamina .label');
    this.staminaBar = document.querySelector('#stamina .bar span');
  }
  
  initializeControls() {
    if (this.isMobile) {
      this.initializeMobileControls();
    } else {
      this.initializeDesktopControls();
    }
  }
  
  initializeDesktopControls() {
    this.controls = new PointerLockControls(this.camera, this.domElement);
    this.camera.up.set(0, 1, 0); this.camera.rotation.order = 'YXZ';
    this.controls.minPolarAngle = 0.1; this.controls.maxPolarAngle = Math.PI - 0.1;
    
    // Add instructions for desktop
    const instructionsDiv = document.createElement("div");
    instructionsDiv.className = "instructions";
    instructionsDiv.innerHTML = "Click to lock controls. <br>Use WASD to move, Space to jump.";
    document.getElementById('game-container').appendChild(instructionsDiv);
    
    // Lock controls only when clicking the canvas (not whole document)
    this.domElement.addEventListener('click', () => {
      if (!this.controls.isLocked) this.controls.lock();
    });

    document.addEventListener('pointerlockchange', () => {
      const escapeMenu = document.getElementById('escape-menu');
      const settingsMenu = document.getElementById('settings-menu');
      const chatInput = document.getElementById('chat-input');
      const isChatting = chatInput && (chatInput.style.display === 'block' || document.activeElement === chatInput);

      if (document.pointerLockElement === this.domElement) {
        escapeMenu.style.display = 'none';
        settingsMenu.style.display = 'none';
      }
    });
    
    // Listen for pointer lock changes
    this.controls.addEventListener('lock', () => {
      if (document.querySelector(".instructions")) {
        document.querySelector(".instructions").style.display = 'none';
      }
    });

    this.controls.addEventListener('unlock', () => {
      if (document.querySelector(".instructions")) {
        document.querySelector(".instructions").style.display = 'block';
      }
    });
    
    // Add rotation change listener to sync rotation even when not moving
    this.controls.addEventListener('change', () => {
      if (this.room) {
        this.camera.rotation.z = 0;
        this.room.updatePresence({ 
          quaternion: this.camera.quaternion.toArray()
        });
      }
    });
  }
  
  initializeMobileControls() {
    // Hide desktop-only UI
    const crosshair = document.querySelector('.crosshair');
    if(crosshair) crosshair.style.display = 'none';
    const keybinds = document.querySelector('.keybinds-info');
    if(keybinds) keybinds.style.display = 'none';

    // Setup camera position first with safe values
    this.camera.position.set(this.playerX, this.playerY + STANDING_CAM_Y_OFFSET, this.playerZ);
    
    // Initialize OrbitControls for camera rotation
    this.orbitControls = new OrbitControls(this.camera, this.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.1;
    this.orbitControls.enableZoom = false;
    this.orbitControls.enablePan = false;
    this.orbitControls.rotateSpeed = 0.4;
    this.orbitControls.minPolarAngle = 0.1; // clamp to prevent over-rotation
    this.orbitControls.maxPolarAngle = Math.PI - 0.1;
    
    // Set the target in front of the camera to ensure valid orientation
    const lookDirection = new THREE.Vector3(0, 0, -1);
    lookDirection.applyQuaternion(this.camera.quaternion);
    this.orbitControls.target.copy(this.camera.position).add(lookDirection);
    this.orbitControls.update(); // Important: update controls immediately

    // Add a change listener to sync rotation for mobile
    this.orbitControls.addEventListener('change', () => {
        if (this.room) {
            this.room.updatePresence({
                quaternion: this.camera.quaternion.toArray()
            });
        }
    });
    
    // Show and setup joystick container for mobile
    const joystickContainer = document.getElementById('joystick-container');
    if(joystickContainer) joystickContainer.style.display = 'block';
    
    // Show and setup jump button for mobile
    const jumpButton = document.getElementById('jump-button');
    if(jumpButton) jumpButton.style.display = 'block';
    
    // Jump button event listeners
    jumpButton.addEventListener('touchstart', (event) => {
      event.preventDefault();
      this.jumpButtonPressed = true;
      if (this.canJump) {
        this.velocity.y = JUMP_FORCE;
        this.canJump = false;
        this.justJumped = true;
        this.jumpSound.currentTime = 0; // Reset sound to start
        this.jumpSound.play().catch(e => console.log("Error playing sound:", e));
      }
    });
    
    jumpButton.addEventListener('touchend', (event) => {
      event.preventDefault();
      this.jumpButtonPressed = false;
    });
    
    // Initialize joystick with improved behavior
    this.joystick = nipplejs.create({
      zone: joystickContainer,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      color: 'rgba(255, 255, 255, 0.5)',
      size: 120
    });
    
    // Joystick move event with better movement handling
    this.joystick.on('move', (evt, data) => {
      const force = Math.min(data.force, 1.0); // Cap force at 1.0
      this.moveVector.set(
        Math.cos(data.angle.radian) * force,
        0,
        -Math.sin(data.angle.radian) * force
      );
    });
    
    // Joystick end event
    this.joystick.on('end', () => {
      this.moveVector.set(0, 0, 0);
    });
    
    // Add interact button for mobile (hidden by default)
    const interactButton = document.getElementById('interact-button');
    if (interactButton) {
      interactButton.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (this.nearDoor) {
          // This simulates the 'E' key press for door opening
           document.dispatchEvent(new CustomEvent('doorOpened', { detail: { } }));
        }
        const npcPrompt = document.getElementById('npc-prompt');
        if (npcPrompt && npcPrompt.style.display !== 'none') {
            this.keysPressed.add('e'); // Simulate key press for NPC interaction logic
            setTimeout(() => this.keysPressed.delete('e'), 100);
        }
      });
    }
  }
  
  setupEventListeners() {
    // Listen for key events (for desktop controls)
    document.addEventListener("keydown", (e) => {
      const chatOpen = document.getElementById('chat-input')?.style.display === 'block';
      const anyMenuOpen = (document.getElementById('escape-menu')?.style.display === 'block') || (document.getElementById('settings-menu')?.style.display === 'block');
      if (chatOpen || anyMenuOpen) return; // prevent movement input while typing/in menu
      const key = e.key.toLowerCase();
      this.keysPressed.add(key);
      
      // Handle jump with spacebar
      if (key === " " && this.canJump) {
        this.velocity.y = JUMP_FORCE;
        this.canJump = false;
        this.justJumped = true;
        this.jumpSound.currentTime = 0; // Reset sound to start
        this.jumpSound.play().catch(e => console.log("Error playing sound:", e));
      }

      // Handle crouching
      if (key === 'control') {
        this.isCrouching = true;
      }
      
      // Listen for 'e' key to open door on desktop
      if ((key === 'e' || key === 'f') && this.nearDoor) {
        document.dispatchEvent(new CustomEvent('doorOpened', { detail: { } }));
      }
      
      if (key === 'shift') { this.isSprinting = true; }

      if (key === 'j') { this.isJumpingJack = true; }

      if (key === 'p') { this.respawn(); }
    });

    document.addEventListener("keyup", (e) => {
      const chatOpen = document.getElementById('chat-input')?.style.display === 'block';
      const anyMenuOpen = (document.getElementById('escape-menu')?.style.display === 'block') || (document.getElementById('settings-menu')?.style.display === 'block');
      if (chatOpen || anyMenuOpen) return;
      const key = e.key.toLowerCase();
      this.keysPressed.delete(key);

      // Handle uncrouching
      if (key === 'control') {
        this.isCrouching = false;
      }
      
      if (key === 'shift') { this.isSprinting = false; }
      if (key === 'j') { this.isJumpingJack = false; }
    });
    
    // Handle window resize
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      if (this.renderer) {
        this.renderer.setSize(window.innerWidth, window.innerHeight);
      }
    });
  }

  respawn() {
    this.camera.position.set(this.spawnPoint.x, this.spawnPoint.y + this.currentCamYOffset, this.spawnPoint.z);
    this.velocity.y = 0;
    this.room.updatePresence({
        x: this.spawnPoint.x,
        y: this.spawnPoint.y,
        z: this.spawnPoint.z,
    });
  }

  setVolume(volume) {
    this.jumpSound.volume = volume;
    this.walkingSound.volume = volume;
  }
  
  // Explicit setter for walking sound volume (used by settings)
  setWalkingVolume(volume) {
    this.walkingSound.volume = volume;
  }
  
  processMovement() {
    const now = performance.now(); const dt = Math.min(0.1, (now - this.lastUpdateTime) / 1000); this.lastUpdateTime = now;
    const chatOpen = document.getElementById('chat-input')?.style.display === 'block';
    const anyMenuOpen = (document.getElementById('escape-menu')?.style.display === 'block') || (document.getElementById('settings-menu')?.style.display === 'block');
    if (chatOpen || anyMenuOpen) {
      if (this.isWalkingSoundPlaying) { this.walkingSound.pause(); this.isWalkingSoundPlaying = false; }
      return;
    }
    
    if (!this.isMobile && document.pointerLockElement !== this.domElement) {
      if (this.isWalkingSoundPlaying) {
        this.walkingSound.pause();
        this.isWalkingSoundPlaying = false;
      }
      return;
    }
    
    console.log('processMovement mobile:', this.isMobile, 'moveForward:', this.moveVector.x, 'moveRight:', this.moveVector.z);
    
    const presence = this.room.presence[this.room.clientId] || {};
    
    // Ensure position values exist with fallbacks
    let x = presence.x || this.playerX;
    let y = presence.y || 0.5;
    let z = presence.z || this.playerZ;
    
    // Create movement vector based on key presses or joystick
    const moveDirection = new THREE.Vector3();
    let isMoving = false;
    
    if (this.isMobile) {
      if (this.moveVector.lengthSq() > 0.001) {
        moveDirection.copy(this.moveVector);
        isMoving = true;
      }
    } else {
      // Keyboard controls for desktop
      // Forward/backward movement
      if (this.keysPressed.has("w") || this.keysPressed.has("arrowup")) {
        moveDirection.z = 1; 
      } else if (this.keysPressed.has("s") || this.keysPressed.has("arrowdown")) {
        moveDirection.z = -1; 
      }
      
      // Left/right movement
      if (this.keysPressed.has("a") || this.keysPressed.has("arrowleft")) {
        moveDirection.x = 1; 
      } else if (this.keysPressed.has("d") || this.keysPressed.has("arrowright")) {
        moveDirection.x = -1; 
      }
      if (moveDirection.lengthSq() > 0) isMoving = true;
    }
    
    if (!this.isMobile && moveDirection.length() > 0) {
      moveDirection.normalize();
    }
    
    // Calculate camera-based movement vectors
    const cameraDirection = new THREE.Vector3();
    this.camera.getWorldDirection(cameraDirection);
    cameraDirection.y = 0; 
    cameraDirection.normalize();
    
    const rightVector = new THREE.Vector3();
    rightVector.crossVectors(this.camera.up, cameraDirection).normalize();
    
    const movement = new THREE.Vector3();
    const baseSpeed = SPEED * (this.isCrouching ? CROUCH_SPEED_MULTIPLIER : 1);
    let sprinting = false;
    
    if (!this.isMobile) {
      // Desktop movement
      if (moveDirection.z !== 0) {
        movement.add(cameraDirection.clone().multiplyScalar(moveDirection.z));
      }
      if (moveDirection.x !== 0) {
        movement.add(rightVector.clone().multiplyScalar(moveDirection.x));
      }
      
      if (movement.length() > 0) {
        movement.normalize().multiplyScalar(baseSpeed);
      }
    } else {
      // Mobile movement: use the joystick values directly (which already incorporate SPEED)
      movement.copy(moveDirection).multiplyScalar(this.isCrouching ? CROUCH_SPEED_MULTIPLIER : 1);
    }
    
    // Sprint handling (desktop only): drain/regen stamina and adjust speed
    if (!this.isMobile && isMoving && this.isSprinting && this.stamina > 0.5) {
      sprinting = true;
      movement.multiplyScalar(this.SPRINT_MULT);
      this.stamina = Math.max(0, this.stamina - this.STAMINA_DRAIN * dt);
    } else {
      const regenRate = (isMoving ? this.STAMINA_REGEN * 0.5 : this.STAMINA_REGEN);
      this.stamina = Math.min(this.STAMINA_MAX, this.stamina + regenRate * dt);
    }
    
    // Update current move vector for first-person limb animation
    this.currentMove.copy(movement);
    
    // Update stamina UI + walking sound rate
    if (this.staminaLabel) this.staminaLabel.textContent = `Stamina: ${Math.round(this.stamina)}%`;
    if (this.staminaBar) this.staminaBar.style.width = `${(this.stamina/this.STAMINA_MAX)*100}%`;
    this.walkingSound.playbackRate = sprinting ? 2.0 : 1.0;
    
    // Apply gravity and vertical velocity
    this.velocity.y -= GRAVITY;
    
    // Calculate new positions
    let newX = this.isMobile ? this.camera.position.x + movement.x : this.camera.position.x + movement.x;
    let newY = y + this.velocity.y;
    let newZ = this.isMobile ? this.camera.position.z + movement.z : this.camera.position.z + movement.z;
    
    // Get all blocks and barriers from the scene
    const blockMeshes = this.scene.children.filter(child => 
      child.userData.isBlock || child.userData.isBarrier);
    
    // Define collision parameters
    const playerRadius = 0.3;
    const playerHeight = this.isCrouching ? CROUCHING_HEIGHT : STANDING_HEIGHT;
    
    let standingOnBlock = false;
    blockMeshes.forEach(block => {
      // Get block dimensions from geometry
      const blockSize = new THREE.Vector3();
      if (block.geometry) {
        const boundingBox = new THREE.Box3().setFromObject(block);
        boundingBox.getSize(blockSize);
      } else {
        // Default size if geometry is not available
        blockSize.set(1, 1, 1);
      }

      const blockWidth = blockSize.x;
      const blockHeight = blockSize.y;
      const blockDepth = blockSize.z;
      
      // Allow jump from a block: improved block standing detection
      if (
        this.velocity.y <= 0 &&
        Math.abs(newX - block.position.x) < (blockWidth / 2 + playerRadius) &&
        Math.abs(newZ - block.position.z) < (blockDepth / 2 + playerRadius) &&
        Math.abs(y - (block.position.y + blockHeight / 2)) < 0.2 &&
        y >= block.position.y
      ) {
        standingOnBlock = true;
        newY = block.position.y + blockHeight / 2 + 0.01; // Place slightly above block
        this.velocity.y = 0;
        this.canJump = true;
      }
      // Horizontal collision detection with improved accuracy
      else if (
        Math.abs(newX - block.position.x) < (blockWidth / 2 + playerRadius) &&
        Math.abs(newZ - block.position.z) < (blockDepth / 2 + playerRadius) &&
        newY < block.position.y + blockHeight / 2 &&
        newY + playerHeight > block.position.y - blockHeight / 2
      ) {
        // Determine overlap on each axis and push out along the minimal penetration axis
        const overlapX = (blockWidth / 2 + playerRadius) - Math.abs(newX - block.position.x);
        const overlapZ = (blockDepth / 2 + playerRadius) - Math.abs(newZ - block.position.z);
        
        // If movement along X caused the collision, resolve X; otherwise resolve Z.
        if (overlapX < overlapZ && Math.abs(movement.x) > 0) {
          // push out on X based on movement direction
          newX += (movement.x > 0) ? -overlapX : overlapX;
        } else if (Math.abs(movement.z) > 0) {
          // push out on Z based on movement direction
          newZ += (movement.z > 0) ? -overlapZ : overlapZ;
        } else {
          // fallback: nudge back to previous position to avoid lock
          newX = this.camera.position.x;
          newZ = this.camera.position.z;
        }
      }
    });
    
    // Prevent jumping through ceiling: find a ceiling mesh and clamp
    const ceiling = this.scene.children.find(c => c.geometry && c.position && Math.abs(c.position.y - 4.5) < 1.5); // increased tolerance for higher ceiling
    if (ceiling) {
      const ceilingY = ceiling.position.y - 0.05; // slightly under to avoid clipping
      const playerTop = newY + playerHeight;
      if (playerTop > ceilingY) {
        newY = ceilingY - playerHeight;
        this.velocity.y = Math.min(this.velocity.y, 0);
      }
    }
    
    // Ground check: keep the player on the ground unless jumping.
    if (newY <= 0.5 && !standingOnBlock) {
      newY = 0.5;
      this.velocity.y = 0;
      this.canJump = true;
    }
    
    // Handle walking sound
    const onGround = this.canJump; // Good proxy for being on the ground
    if (isMoving && onGround) {
      if (!this.isWalkingSoundPlaying) {
        this.walkingSound.play().catch(e => console.log("Error playing walking sound:", e));
        this.isWalkingSoundPlaying = true;
      }
    } else {
      if (this.isWalkingSoundPlaying) {
        this.walkingSound.pause();
        this.isWalkingSoundPlaying = false;
      }
    }
    // Share walking state for remote animation
    try { this.room.updatePresence({ walking: !!(isMoving && onGround) }); } catch {}
    
    // Door proximity detection and UI handling
    // Find nearest door within 2 units
    const door = this.scene.children.find(c => c.userData && c.userData.isDoor);
    this.nearDoor = null;
    if (door) {
      const px = newX, pz = newZ, py = newY;
      const dist = Math.hypot(px - door.position.x, pz - door.position.z);
      if (dist < 2.0) {
        this.nearDoor = door;
        // Show prompt UI: desktop shows small hint, mobile shows button
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
        const ob = document.getElementById('open-button');
        if (ob) ob.style.display = 'block';
      } else {
        if (document.getElementById('open-prompt')) document.getElementById('open-prompt').style.display = 'none';
        if (document.getElementById('open-button')) document.getElementById('open-button').style.display = 'none';
      }
    }
    
    // Only update if position changed
    if (newX !== presence.x || newY !== presence.y || newZ !== presence.z) {
      // Update minimap reveal
      const minimapData = this.scene.userData.minimap;
      if (minimapData) {
          const { cols, rows, cellSize, revealed } = minimapData;
          const c = Math.floor((newX / cellSize) + cols / 2);
          const r = Math.floor((newZ / cellSize) + rows / 2);
          if (r >= 0 && r < rows && c >= 0 && c < cols && !revealed[r][c]) {
              // Reveal this cell and its immediate neighbors for a smoother look
              for (let dr = -1; dr <= 1; dr++) {
                  for (let dc = -1; dc <= 1; dc++) {
                      const nr = r + dr;
                      const nc = c + dc;
                      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                          revealed[nr][nc] = true;
                      }
                  }
              }
              minimapData.needsUpdate = true;
          } else if (Math.random() < 0.1) { // periodically request redraw for other players
              minimapData.needsUpdate = true;
          }
      }

      // Update camera position; add eye offset above player center
      const onGround = this.canJump;
      const moveMag = this.currentMove.length();
      if (onGround && moveMag > 0.001) {
        // smoother, slightly slower bob; no speed up on sprint
        this.bobTime += moveMag * 4.5;
      }
      const bobY = (onGround ? Math.sin(this.bobTime) * 0.012 : 0); // reduced bob amplitude
      
      // Smooth crouch transition
      const targetCamYOffset = this.isCrouching ? CROUCHING_CAM_Y_OFFSET : STANDING_CAM_Y_OFFSET;
      this.currentCamYOffset += (targetCamYOffset - this.currentCamYOffset) * CROUCH_TRANSITION_SPEED;
      
      this.camera.position.set(newX, newY + this.currentCamYOffset + bobY, newZ);
      this.camera.rotation.z = 0; // prevent unintended roll/tilt
      
      if (this.isMobile && this.orbitControls) {
        const cameraDirection = new THREE.Vector3();
        this.camera.getWorldDirection(cameraDirection);
        this.orbitControls.target.copy(this.camera.position).add(cameraDirection);
      }
      
      this.room.updatePresence({ 
        x: newX, 
        y: newY, 
        z: newZ,
        quaternion: this.camera.quaternion.toArray()
      });
    }
    
    if (this.isMobile && this.orbitControls) {
      this.orbitControls.update();
    }
  }
  
  update() {
    this.processMovement();
    
    // Draw minimap if needed
    if (this.scene.userData.minimap && this.scene.userData.minimap.needsUpdate) {
        // This is a bit of a hack, but controls is updated in the animation loop where we can't easily pass scene back up.
        // So we'll call a global-like function.
        if (typeof window.drawMinimap === 'function') {
            window.drawMinimap(this.scene);
        }
    }

    // Spring physics for hands
    const { target, current, velocity } = this.handState;
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    target.set(-euler.y * 0.4, euler.x * 0.4, 0);
    const springConstant = 120;
    const damping = 18;
    const force = new THREE.Vector3().subVectors(target, current);
    const dampingForce = new THREE.Vector3().copy(velocity).multiplyScalar(-damping);
    const totalForce = force.multiplyScalar(springConstant).add(dampingForce);
    velocity.add(totalForce.multiplyScalar(1/60)); // Assume 60fps for dt
    current.add(velocity.multiplyScalar(1/60));
    
    // Apply this smoothed position to the first-person hands/limbs group
    const fpLimbs = this.camera.getObjectByName('fpLimbs');
    if (fpLimbs) {
      fpLimbs.position.copy(current); // two hands follow with springy motion
    }
  }
  
  getCamera() {
    return this.camera;
  }
}