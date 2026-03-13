export class AudioRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  async start(onData: (base64: string) => void, existingStream?: MediaStream, onVolume?: (volume: number) => void) {
    try {
      this.stream = existingStream || await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // Log device info for debugging
      const audioTracks = this.stream.getAudioTracks();
      if (audioTracks.length > 0) {
        console.log(`Using audio device: ${audioTracks[0].label}`);
      } else {
        throw new Error('No audio tracks found in stream');
      }

      this.context = new AudioContext({ sampleRate: 16000 });
      console.log(`AudioContext state: ${this.context.state}, sampleRate: ${this.context.sampleRate}`);
      
      if (this.context.state === 'suspended') {
        await this.context.resume();
        console.log('AudioContext resumed');
      }
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        const channelData = e.inputBuffer.getChannelData(0);
        
        // Calculate volume (RMS)
        if (onVolume) {
          let sum = 0;
          for (let i = 0; i < channelData.length; i++) {
            sum += channelData[i] * channelData[i];
          }
          const rms = Math.sqrt(sum / channelData.length);
          onVolume(rms);
        }

        const pcm16 = new Int16Array(channelData.length);
        for (let i = 0; i < channelData.length; i++) {
          let s = Math.max(-1, Math.min(1, channelData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Convert to base64
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        onData(window.btoa(binary));
      };

      this.source.connect(this.processor);
      this.processor.connect(this.context.destination);
    } catch (err) {
      console.error('Error starting audio recorder:', err);
      throw err;
    }
  }

  stop() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.context) {
      this.context.close();
      this.context = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
