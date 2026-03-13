export class AudioStreamer {
  private context: AudioContext | null = null;
  private nextTime: number = 0;

  init() {
    this.context = new AudioContext({ sampleRate: 24000 });
    this.nextTime = this.context.currentTime;
  }

  play(base64: string) {
    if (!this.context) return;

    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const buffer = this.context.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    const currentTime = this.context.currentTime;
    if (this.nextTime < currentTime) {
      this.nextTime = currentTime;
    }
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  stop() {
    if (this.context) {
      this.context.close();
      this.context = null;
    }
    this.nextTime = 0;
  }
}
