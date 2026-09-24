/**
 * A PathLayer that shows only the part of a track inside a time window, filtered on the GPU.
 *
 * Every vertex carries its time (seconds since the dataset epoch). The fragment shader discards
 * everything outside [windowStartRelS, windowEndRelS], so moving the timeline changes two uniforms: no
 * attribute rebuild, no re-tessellation, no network. Older samples in the window fade towards
 * `fadeFloor`, which shows the direction of travel at a glance.
 *
 * Same technique as deck.gl's TripsLayer (per-vertex timestamps interpolated along each segment),
 * which only supports a trailing window ending at `currentTime`; here both ends are free.
 */
import type { DefaultProps } from '@deck.gl/core';
import { PathLayer, type PathLayerProps } from '@deck.gl/layers';
import type { ShaderModule } from '@luma.gl/shadertools';

const uniformBlock = /* glsl */ `\
layout(std140) uniform trackWindowUniforms {
  float startTime;
  float endTime;
  float fadeFloor;
} trackWindow;
`;

interface TrackWindowUniforms {
  startTime: number;
  endTime: number;
  fadeFloor: number;
}

const trackWindowModule = {
  name: 'trackWindow',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: { startTime: 'f32', endTime: 'f32', fadeFloor: 'f32' },
} as const satisfies ShaderModule<TrackWindowUniforms>;

const injections = {
  'vs:#decl': /* glsl */ `\
in float instanceTimestamps;
in float instanceNextTimestamps;
out float vTime;
`,
  'vs:#main-end': /* glsl */ `\
vTime = instanceTimestamps + (instanceNextTimestamps - instanceTimestamps) * vPathPosition.y / vPathLength;
`,
  'fs:#decl': /* glsl */ `\
in float vTime;
`,
  // After PathLayer's own coverage logic, like TripsLayer.
  'fs:DECKGL_FILTER_COLOR': /* glsl */ `\
if (vTime < trackWindow.startTime || vTime > trackWindow.endTime) {
  discard;
}
float age = (trackWindow.endTime - vTime) / max(trackWindow.endTime - trackWindow.startTime, 1.0);
color.a *= mix(1.0, trackWindow.fadeFloor, age);
`,
};

interface TrackLayerExtraProps {
  /** Visible window, in the same clock as the timestamps (seconds since the dataset epoch). */
  windowStartRelS: number;
  windowEndRelS: number;
  /** Opacity multiplier at the oldest end of the window (1 = no fade). */
  fadeFloor: number;
}

interface LayerShaders {
  vs: string;
  fs: string;
  modules: unknown[];
  inject?: Record<string, string>;
}

export type TrackLayerProps = PathLayerProps & TrackLayerExtraProps;

const defaultProps: DefaultProps<TrackLayerProps> = {
  windowStartRelS: { type: 'number', value: 0 },
  windowEndRelS: { type: 'number', value: 0 },
  fadeFloor: { type: 'number', value: 1, min: 0, max: 1 },
};

export class TrackLayer extends PathLayer<unknown, TrackLayerExtraProps> {
  static override readonly layerName = 'TrackLayer';
  static override readonly defaultProps = defaultProps;

  override getShaders(): LayerShaders {
    // deck.gl types getShaders() as `any`; this is the shape PathLayer returns.
    const shaders = super.getShaders() as LayerShaders;
    return { ...shaders, inject: injections, modules: [...shaders.modules, trackWindowModule] };
  }

  override initializeState() {
    super.initializeState();
    // Binary data supplies `attributes.getTimestamps` ({ value: Float32Array, size: 1 }).
    this.getAttributeManager()?.addInstanced({
      timestamps: {
        size: 1,
        accessor: 'getTimestamps',
        shaderAttributes: {
          instanceTimestamps: { vertexOffset: 0 },
          instanceNextTimestamps: { vertexOffset: 1 },
        },
      },
    });
  }

  override draw(params: Parameters<PathLayer['draw']>[0]) {
    const { windowStartRelS, windowEndRelS, fadeFloor } = this.props;
    this.state.model?.shaderInputs.setProps({
      trackWindow: { startTime: windowStartRelS, endTime: windowEndRelS, fadeFloor },
    });
    super.draw(params);
  }
}
