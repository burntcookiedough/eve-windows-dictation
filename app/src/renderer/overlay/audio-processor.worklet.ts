/// <reference path="./audio-worklet.d.ts" />

class AudioProcessor extends AudioWorkletProcessor {
  override process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const channelData = input[0];
      this.port.postMessage({ audioData: channelData });
    }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
