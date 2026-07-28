import { useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, ContactShadows } from '@react-three/drei'
import { botToMeshes } from '../../lib/scene/botToMeshes.js'
import CadPart from '../scene/CadPart.jsx'
import DesignReview from './DesignReview.jsx'
import { downscaleCanvas } from '../../lib/critique/capture.js'

const SELECT = '#1fe3e8'
const EDGE = '#20303d'

function ModuleMesh({ d, selected, hovered, onSelect, onHover }) {
  return (
    <group
      position={d.position}
      onClick={(e) => { e.stopPropagation(); onSelect(d.id) }}
      onPointerOver={(e) => { e.stopPropagation(); onHover(d.id) }}
      onPointerOut={(e) => { e.stopPropagation(); onHover(null) }}
    >
      {d.parts.map((part, i) => (
        <CadPart
          key={i}
          geometry={part.geometry}
          args={part.args}
          position={part.position}
          rotation={part.rotation}
          color={d.color}
          // selection and hover are carried by the outline, not by making the
          // whole part glow — the material colour has to keep meaning "metal"
          edgeColor={selected ? SELECT : hovered ? '#8fa6b6' : EDGE}
        />
      ))}
    </group>
  )
}

// Hands the parent a function that renders the current frame and reads it back
// as a downscaled JPEG data URL (see capture.js — a full-size retina PNG is too
// big for the deployed /critique body limit). The read has to happen
// immediately after a draw — with the default
// swap-chain the buffer is already cleared by the time an event handler runs,
// which is why the canvas below asks for preserveDrawingBuffer.
function CaptureBridge({ onReady }) {
  const { gl, scene, camera } = useThree()
  onReady(() => {
    gl.render(scene, camera)
    return downscaleCanvas(gl.domElement)
  })
  return null
}

export default function BotScene({ bot, cg, derived, selectedId, onSelect, opponent }) {
  const meshes = botToMeshes(bot)
  const [hoveredId, setHoveredId] = useState(null)
  const captureRef = useRef(null)

  return (
    <div className="relative h-full w-full">
      {/* viewport HUD overlay */}
      <div className="absolute top-4 left-4 z-10 pointer-events-none">
        <div className="eyebrow">Live preview</div>
      </div>
      <div className="absolute top-4 right-4 z-10 pointer-events-none flex items-center gap-2">
        <span className="w-2 h-2 rounded-full" style={{ background: 'var(--amber)', boxShadow: '0 0 8px var(--amber)' }} />
        <span className="mono text-[10px] text-[var(--ink-3)]">Center of gravity</span>
      </div>

      {/* A 250 lb bot is ~0.6 m across. The old camera sat far enough back to fit
          a three-metre object, so the part being edited occupied a fifth of the
          viewport with dead grid all around it. */}
      {derived && (
        <DesignReview
          capture={() => captureRef.current?.()}
          bot={bot}
          derived={derived}
          opponent={opponent}
        />
      )}

      <Canvas
        shadows
        camera={{ position: [1.02, 0.66, 1.02], fov: 42 }}
        style={{ height: '100%', width: '100%' }}
        // the design reviewer reads this canvas back as a PNG; without it the
        // buffer is undefined by the time toDataURL is called
        gl={{ preserveDrawingBuffer: true }}
      >
        <CaptureBridge onReady={(fn) => { captureRef.current = fn }} />
        <color attach="background" args={['#08090d']} />
        <fog attach="fog" args={['#08090d', 3, 9]} />
        {/* one hard key light plus weak fill, so parts cast real shadows on each
            other and the form is readable */}
        <ambientLight intensity={0.28} />
        <hemisphereLight args={['#9fb4c4', '#0a0a12', 0.35]} />
        <directionalLight
          position={[1.6, 2.6, 1.2]}
          intensity={2.2}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-1.2}
          shadow-camera-right={1.2}
          shadow-camera-top={1.2}
          shadow-camera-bottom={-1.2}
          shadow-camera-near={0.1}
          shadow-camera-far={8}
          shadow-bias={-0.0005}
        />
        <pointLight position={[-3, 2, -2]} intensity={0.5} color="#1fe3e8" />
        <pointLight position={[2, 1, -3]} intensity={0.35} color="#ff2e6e" />

        {/* measured grid: 10 cm minor, 50 cm major, muted to read as drafting
            paper rather than neon */}
        <Grid
          args={[10, 10]}
          cellSize={0.1}
          cellColor="#1b2430"
          sectionSize={0.5}
          sectionColor="#33566a"
          fadeDistance={9}
          fadeStrength={1.5}
          infiniteGrid
          position={[0, -0.2, 0]}
        />
        {/* sits just under the wheels, not down at the grid — a contact shadow
            cast onto empty space 6 cm below the bot reads as no shadow at all */}
        <ContactShadows position={[0, -0.142, 0]} opacity={0.7} scale={2.4} blur={1.6} far={0.6} resolution={1024} />

        {meshes.map((d) => (
          <ModuleMesh
            key={d.id}
            d={d}
            selected={d.id === selectedId}
            hovered={d.id === hoveredId}
            onSelect={onSelect}
            onHover={setHoveredId}
          />
        ))}

        {cg && (
          <mesh position={cg}>
            <sphereGeometry args={[0.03, 16, 16]} />
            <meshBasicMaterial color="#ffab12" />
          </mesh>
        )}
        {/* bounded so a stray scroll can neither bury the camera inside the
            chassis nor fling it out past the fog */}
        {/* Target sits slightly forward of the chassis origin: the weapon hangs
            off the nose, so orbiting around 0,0,0 pushed the whole bot into the
            right of the frame and left the left third empty. */}
        <OrbitControls makeDefault target={[0.08, -0.03, 0]} minDistance={0.45} maxDistance={2.6} maxPolarAngle={Math.PI * 0.495} enablePan={false} />
      </Canvas>
    </div>
  )
}
