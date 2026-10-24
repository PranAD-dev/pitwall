import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { clamp } from './util.js';

// ---------------------------------------------------------------------------
// postfx.js — broadcast finishing chain for the night match at the Stade Raoul Brulat.
//
// Chain (r166 order matters):
//   SceneDepthPass        scene → private HDR+MSAA buffer WITH a depth texture,
//                         then blitted into the composer ping-pong. The private
//                         buffer exists so the depth attachment is never bound
//                         as a render target again later in the chain (a
//                         shared depth texture + ping-pong = feedback loop).
//   UnrealBloomPass       lamp faces / LED boards / wet-line + kit speculars.
//                         Runs BEFORE defocus so a floodlight bank blooms at
//                         its true intensity and the halo defocuses with it.
//   Lens ShaderPass       depth-of-field (CoC gather, autofocus off the frame
//                         centre) → height-gated aerial haze → filmic grade
//                         (toe / midtone contrast / highlight expansion) →
//                         cool shadow floor, saturation, vignette, grain.
//                         Runs in scene-linear HDR, pre-tonemap.
//   SMAAPass              polish on top of the 4x MSAA resolve.
//   OutputPass            LAST — applies ACES tonemapping + sRGB encode.
//
// Deterministic: grain advances from accumulated dt, no clocks, no rng needed.
// ---------------------------------------------------------------------------

const CopyShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }
  `,
};

/**
 * RenderPass that always draws into its own HDR target (which carries the
 * depth texture the lens pass needs), then copies the colour into the
 * composer's read buffer so the rest of the chain is completely standard.
 */
class SceneDepthPass extends RenderPass {
  constructor(scene, camera, target) {
    super(scene, camera);
    this.needsSwap = false;
    this.target = target;
    this._copyMat = new THREE.ShaderMaterial({
      name: 'PostFX.blit',
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this._quad = new FullScreenQuad(this._copyMat);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const toScreen = this.renderToScreen;
    this.renderToScreen = false;
    super.render(renderer, writeBuffer, this.target, deltaTime, maskActive);
    this.renderToScreen = toScreen;

    this._copyMat.uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(toScreen ? null : readBuffer);
    this._quad.render(renderer);
  }

  setSize(width, height) {
    this.target.setSize(width, height);
  }

  dispose() {
    this._quad.dispose();
    this._copyMat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Lens + grade
// ---------------------------------------------------------------------------

function makeLensShader(taps) {
  return {
    name: 'BroadcastLensShader',

    defines: { DOF_TAPS: taps },

    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      // 1 / render-target size, in device pixels.
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      // Blur radii are authored at 1080p and scaled to the actual buffer.
      uPixelScale: { value: 1.0 },

      // --- camera / depth linearisation -----------------------------------
      uNear: { value: 0.3 },
      uFar: { value: 1600.0 },
      // tan(halfFov) per axis, pulled straight off the projection matrix so
      // zoom / film offset stay correct.
      uTanHalf: { value: new THREE.Vector2(0.4, 0.3) },
      uCamY: { value: 20.0 },
      // Row 1 of the camera's world rotation — enough to recover world height
      // from a view-space ray without a full matrix multiply.
      uCamRowY: { value: new THREE.Vector3(0, 1, 0) },

      // --- depth of field ---------------------------------------------------
      // Broadcast lenses at a 55 m throw hold the pitch and let the stands go.
      uDof: { value: 1.0 },        // master amount (0 disables the gather)
      uFocusFallback: { value: 55.0 },
      uFarRange: { value: 0.70 },  // (z-f)/z at which far blur saturates
      uNearRange: { value: 2.40 }, // (f-z)/z at which near blur saturates
      uFarMax: { value: 1.0 },
      uNearMax: { value: 0.45 },
      uMaxRadius: { value: 3.2 },  // px at 1080p

      // --- aerial haze ------------------------------------------------------
      // Lit night air. Gated by world height so the pitch stays crisp and the
      // far roofline / upper tiers sit behind a little atmosphere.
      uHaze: { value: 0.45 },
      uHazeStart: { value: 38.0 },
      uHazeDensity: { value: 0.0042 },
      uHazeY: { value: new THREE.Vector2(11.0, 40.0) },
      uHazeColor: { value: new THREE.Vector3(0.062, 0.070, 0.086) },

      // --- filmic grade (scene-linear, before the ACES shoulder) -------------
      uExposure: { value: 1.14 },
      uPivot: { value: 0.16 },
      uContrast: { value: 1.15 },
      uToe: { value: 0.40 },
      uToeRange: { value: 0.14 },
      uHiGain: { value: 0.28 },
      uHiKnee: { value: new THREE.Vector2(0.38, 1.10) },
      uSaturation: { value: 1.10 },
      uShadowTint: { value: new THREE.Vector3(0.935, 0.968, 1.036) },
      uVignette: { value: 0.26 },

      // --- grain -------------------------------------------------------------
      uGrain: { value: 0.006 },
      uGrainSeed: { value: 0.0 },
    },

    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,

    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform sampler2D tDepth;
      uniform vec2 uTexel;
      uniform float uPixelScale;

      uniform float uNear;
      uniform float uFar;
      uniform vec2 uTanHalf;
      uniform float uCamY;
      uniform vec3 uCamRowY;

      uniform float uDof;
      uniform float uFocusFallback;
      uniform float uFarRange;
      uniform float uNearRange;
      uniform float uFarMax;
      uniform float uNearMax;
      uniform float uMaxRadius;

      uniform float uHaze;
      uniform float uHazeStart;
      uniform float uHazeDensity;
      uniform vec2 uHazeY;
      uniform vec3 uHazeColor;

      uniform float uExposure;
      uniform float uPivot;
      uniform float uContrast;
      uniform float uToe;
      uniform float uToeRange;
      uniform float uHiGain;
      uniform vec2 uHiKnee;
      uniform float uSaturation;
      uniform vec3 uShadowTint;
      uniform float uVignette;

      uniform float uGrain;
      uniform float uGrainSeed;

      varying vec2 vUv;

      float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

      // Dave Hoskins hash12 — stable, no sin(), safe at our coordinate ranges.
      float hash12( vec2 p ) {
        vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
        p3 += dot( p3, p3.yzx + 33.33 );
        return fract( ( p3.x + p3.y ) * p3.z );
      }

      // Window depth → metres in front of the lens (along the view axis).
      float viewDist( vec2 uv ) {
        float d = texture2D( tDepth, uv ).x;
        float vz = ( uNear * uFar ) / ( ( uFar - uNear ) * d - uFar );
        return -vz;
      }

      // Signed circle-of-confusion, in pixels at the current buffer size.
      float coc( float z, float focus ) {
        float c = ( z - focus ) / max( z, 0.5 );
        float far  = clamp(  c / uFarRange,  0.0, 1.0 ) * uFarMax;
        float near = clamp( -c / uNearRange, 0.0, 1.0 ) * uNearMax;
        return max( far, near ) * uMaxRadius * uPixelScale * uDof;
      }

      void main() {
        // -------------------------------------------------------------------
        // Autofocus: a five-tap box in the middle of the frame, MEDIAN
        // distance wins. Median rather than nearest so one post, one railing
        // or one gap to the far stand inside the focus box cannot yank the
        // whole rack — that is what makes a rig look like an amateur pulling
        // focus. Sky-only centre falls back to the solved ground throw.
        // -------------------------------------------------------------------
        float skyZ = uFar * 0.55;
        const float BIG = 1.0e6;
        vec2 c0 = vec2( 0.5, 0.5 );
        float a0 = viewDist( c0 + vec2( -0.035, 0.0 ) );
        float a1 = viewDist( c0 + vec2(  0.035, 0.0 ) );
        float a2 = viewDist( c0 );
        float a3 = viewDist( c0 + vec2( 0.0, -0.045 ) );
        float a4 = viewDist( c0 + vec2( 0.0,  0.045 ) );
        a0 = a0 < skyZ ? a0 : BIG;  a1 = a1 < skyZ ? a1 : BIG;
        a2 = a2 < skyZ ? a2 : BIG;  a3 = a3 < skyZ ? a3 : BIG;
        a4 = a4 < skyZ ? a4 : BIG;
        // 6-comparator median-of-5 sorting network; a2 ends up as the median.
        float lo, hi;
        lo = min( a0, a1 ); hi = max( a0, a1 ); a0 = lo; a1 = hi;
        lo = min( a3, a4 ); hi = max( a3, a4 ); a3 = lo; a4 = hi;
        lo = min( a0, a3 ); hi = max( a0, a3 ); a0 = lo; a3 = hi;
        lo = min( a1, a4 ); hi = max( a1, a4 ); a1 = lo; a4 = hi;
        lo = min( a1, a2 ); hi = max( a1, a2 ); a1 = lo; a2 = hi;
        lo = min( a2, a3 ); hi = max( a2, a3 ); a2 = lo; a3 = hi;
        lo = min( a1, a2 ); hi = max( a1, a2 ); a1 = lo; a2 = hi;
        float focus = ( a2 > BIG * 0.5 ) ? uFocusFallback : clamp( a2, 3.0, 150.0 );

        float zC = viewDist( vUv );
        float rC = coc( zC, focus );

        vec4 texel = texture2D( tDiffuse, vUv );
        vec3 col = max( texel.rgb, vec3( 0.0 ) );

        // -------------------------------------------------------------------
        // Defocus gather. Golden-angle spiral, per-pixel rotated so the low
        // tap count never bands. A tap only lands on us if its own circle of
        // confusion is wide enough to reach — that keeps a sharp foreground
        // from smearing into the blurred stands behind it.
        // -------------------------------------------------------------------
        if ( rC > 0.65 ) {
          float ang = hash12( gl_FragCoord.xy ) * 6.2831853;
          vec2 dir = vec2( cos( ang ), sin( ang ) );
          const float GA = 2.39996323;
          vec2 rot = vec2( cos( GA ), sin( GA ) );

          vec3 sum = col;
          float wsum = 1.0;

          for ( int i = 0; i < DOF_TAPS; i++ ) {
            dir = vec2( dir.x * rot.x - dir.y * rot.y, dir.x * rot.y + dir.y * rot.x );
            float rr = sqrt( ( float( i ) + 0.5 ) / float( DOF_TAPS ) );
            vec2 offPx = dir * rr * rC;
            vec2 uv = clamp( vUv + offPx * uTexel, vec2( 0.0 ), vec2( 1.0 ) );
            float rT = coc( viewDist( uv ), focus );
            float w = clamp( rT - length( offPx ) + 1.0, 0.0, 1.0 );
            sum += max( texture2D( tDiffuse, uv ).rgb, vec3( 0.0 ) ) * w;
            wsum += w;
          }
          col = sum / wsum;
        }

        // -------------------------------------------------------------------
        // Height-gated aerial haze. Reconstruct the world height of this
        // fragment from the view ray; only air well above the pitch scatters,
        // so the grass stays clean while the far roofline and upper tiers
        // gain a little depth. The sky dome is excluded.
        // -------------------------------------------------------------------
        vec2 ndc = vUv * 2.0 - 1.0;
        vec3 viewP = vec3( ndc.x * uTanHalf.x * zC, ndc.y * uTanHalf.y * zC, -zC );
        float worldY = uCamY + dot( uCamRowY, viewP );
        float hz = 1.0 - exp( -uHazeDensity * max( zC - uHazeStart, 0.0 ) );
        hz *= smoothstep( uHazeY.x, uHazeY.y, worldY );
        hz *= 1.0 - smoothstep( 300.0, 480.0, zC );
        col = mix( col, uHazeColor, clamp( hz * uHaze, 0.0, 1.0 ) );

        // -------------------------------------------------------------------
        // Filmic grade. Exposure → midtone contrast about a pivot near the
        // floodlit-grass level → toe (shadow sides of players go dark) →
        // highlight expansion so specular content has somewhere to go before
        // the ACES shoulder in OutputPass rolls it off.
        // -------------------------------------------------------------------
        col *= uExposure;
        col = pow( col * ( 1.0 / uPivot ), vec3( uContrast ) ) * uPivot;

        float l = luma( col );
        col *= mix( 1.0 - uToe, 1.0, smoothstep( 0.0, uToeRange, l ) );

        l = luma( col );
        col *= 1.0 + uHiGain * smoothstep( uHiKnee.x, uHiKnee.y, l );

        // Cool shadow floor. Masked to the darks so floodlit grass and kits
        // keep their neutral whites; only stands/sky/shadow sides shift.
        l = luma( col );
        float shadowMask = 1.0 - smoothstep( 0.0, 0.30, l );
        col *= mix( vec3( 1.0 ), uShadowTint, shadowMask );

        // Saturation (luma-preserving).
        l = luma( col );
        col = max( mix( vec3( l ), col, uSaturation ), vec3( 0.0 ) );

        // Elliptical broadcast vignette. d = 1.0 exactly at the corners,
        // 0.707 at edge midpoints; centre (d < 0.46) is untouched.
        vec2 q = vUv - 0.5;
        float d = length( q ) * 1.41421356;
        col *= 1.0 - uVignette * smoothstep( 0.46, 1.0, d );

        // Monochrome sensor grain, weighted INTO the highlights and gated off
        // below the night-sky level so the upper band stays clean.
        l = luma( col );
        float gw = smoothstep( 0.030, 0.095, l ) * ( 0.25 + 0.75 * min( l * 3.0, 1.0 ) );
        float n = hash12( gl_FragCoord.xy + vec2( uGrainSeed * 31.7, uGrainSeed * 17.3 ) );
        col += ( n - 0.5 ) * uGrain * gw;

        gl_FragColor = vec4( max( col, vec3( 0.0 ) ), texel.a );
      }
    `,
  };
}

export function createPostFX(ctx, { camera }) {
  const { renderer, scene, quality } = ctx;
  const low = quality === 'low';

  const size = renderer.getSize(new THREE.Vector2());
  const pixelRatio = renderer.getPixelRatio();
  const pw = Math.max(1, Math.floor(size.x * pixelRatio));
  const ph = Math.max(1, Math.floor(size.y * pixelRatio));

  // --- Private scene buffer: HDR + MSAA + depth ------------------------------
  // WebGL2 is guaranteed on r166, so `samples` gives hardware-resolved
  // geometric edges, and the depth attachment resolves with them.
  const sceneTarget = new THREE.WebGLRenderTarget(pw, ph, {
    type: THREE.HalfFloatType,
    samples: low ? 2 : 4,
    stencilBuffer: false,
  });
  sceneTarget.texture.name = 'PostFX.scene';
  sceneTarget.depthTexture = new THREE.DepthTexture(pw, ph, THREE.UnsignedIntType);
  sceneTarget.depthTexture.name = 'PostFX.depth';

  // Composer ping-pong buffers carry no MSAA (already resolved above) and no
  // depth texture — nothing downstream needs one.
  const ldrTarget = new THREE.WebGLRenderTarget(pw, ph, {
    type: THREE.HalfFloatType,
    stencilBuffer: false,
  });
  ldrTarget.texture.name = 'PostFX.hdr';

  const composer = new EffectComposer(renderer, ldrTarget);

  // --- 1. Scene (+ depth) ----------------------------------------------------
  const renderPass = new SceneDepthPass(scene, camera, sceneTarget);
  composer.addPass(renderPass);

  // --- 2. Bloom --------------------------------------------------------------
  // Threshold sits above floodlit grass and kit diffuse but below the lamp
  // faces, the LED boards, the wet line paint and the specular pings off the
  // posts and the ball — so the frame finally has a highlight event. Wide
  // radius: a tight core with a faint several-degree halo, the look of a
  // broadcast lens pointed at a floodlight.
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(pw, ph),
    0.32, // strength
    0.88, // radius
    0.72  // threshold (scene-linear luminance, pre-tonemap)
  );
  // Widen the high-pass knee from the harsh 0.01 default so glow fades in
  // smoothly instead of popping when a lamp edges across the threshold.
  bloomPass.highPassUniforms['smoothWidth'].value = 0.25;
  composer.addPass(bloomPass);

  // --- 3. Lens (DOF + haze) + broadcast grade --------------------------------
  const lensShader = makeLensShader(low ? 6 : 12);
  const gradePass = new ShaderPass(lensShader);
  const gu = gradePass.uniforms;
  gu.tDepth.value = sceneTarget.depthTexture;
  if (low) {
    gu.uGrain.value = 0.005;
    gu.uMaxRadius.value = 2.6;
  }
  composer.addPass(gradePass);

  // --- 4. SMAA ---------------------------------------------------------------
  // MSAA has already cleaned geometric edges; SMAA mops up shader/specular
  // aliasing. Its lookup textures decode async from embedded data URIs — for
  // the first frame or two MSAA alone carries the image, which is fine.
  let smaaPass = null;
  if (!low) {
    smaaPass = new SMAAPass(pw, ph);
    composer.addPass(smaaPass);
  }

  // --- 5. Output (must be last on r166) --------------------------------------
  // Applies renderer.toneMapping (ACES, exposure 1.1) + sRGB encode exactly
  // once, at the end of the chain.
  composer.addPass(new OutputPass());

  // Normalize composer logical size to CSS pixels (constructing with a custom
  // target leaves _width/_height in device pixels otherwise).
  composer.setSize(size.x, size.y);

  // --- Runtime ---------------------------------------------------------------
  let timeAcc = 0;

  function syncCamera() {
    const e = camera.projectionMatrix.elements;
    // P[0] = 1/(aspect*tan(fovY/2)), P[5] = 1/tan(fovY/2)
    const tx = e[0] !== 0 ? 1 / Math.abs(e[0]) : 0.5;
    const ty = e[5] !== 0 ? 1 / Math.abs(e[5]) : 0.35;
    gu.uTanHalf.value.set(tx, ty);
    gu.uNear.value = camera.near;
    gu.uFar.value = camera.far;

    const m = camera.matrixWorld.elements;
    gu.uCamRowY.value.set(m[1], m[5], m[9]);
    gu.uCamY.value = m[13];

    // Fallback focus when the frame centre is nothing but sky: where the view
    // axis meets chest height over the pitch, otherwise the nominal TV throw.
    const dy = m[9] * -1; // world Y of camera forward (-Z column)
    let fb = 55;
    if (dy < -0.02) fb = clamp((1.0 - m[13]) / dy, 8, 130);
    gu.uFocusFallback.value = fb;
  }

  function update(dt) {
    timeAcc += dt;
    // Re-seed grain at display rate; 64-frame cycle keeps hash coords small.
    gu.uGrainSeed.value = Math.floor(timeAcc * 60) % 64;
    syncCamera();
  }

  function resize(w, h) {
    const pr = renderer.getPixelRatio();
    composer.setPixelRatio(pr);
    composer.setSize(w, h); // cascades device-pixel sizes to every pass + RTs
    const dw = Math.max(1, Math.floor(w * pr));
    const dh = Math.max(1, Math.floor(h * pr));
    gu.uTexel.value.set(1 / dw, 1 / dh);
    gu.uPixelScale.value = dh / 1080;
    syncCamera();
  }

  resize(size.x, size.y);

  return { composer, update, resize, bloomPass, gradePass, smaaPass };
}
