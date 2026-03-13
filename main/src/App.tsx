import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type } from '@google/genai';
import { AudioRecorder } from './lib/audio-recorder';
import { AudioStreamer } from './lib/audio-streamer';
import { Mic, MicOff, Activity, Terminal, CheckCircle2, AlertCircle, Settings } from 'lucide-react';

type LogEntry = {
  id: string;
  type: 'system' | 'user' | 'model' | 'tool';
  message: string;
  timestamp: Date;
};

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [volume, setVolume] = useState(0);
  const [showMicHint, setShowMicHint] = useState(false);
  
  const aiRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<any>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Initialize AI client
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      aiRef.current = new GoogleGenAI({ apiKey });
    } else {
      addLog('system', 'Error: GEMINI_API_KEY is missing. Please configure it in the AI Studio settings.');
    }

    audioRecorderRef.current = new AudioRecorder();
    audioStreamerRef.current = new AudioStreamer();

    return () => {
      disconnect();
    };
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    let timer: any;
    if (isConnected && volume === 0) {
      timer = setTimeout(() => {
        setShowMicHint(true);
      }, 3000);
    } else {
      setShowMicHint(false);
    }
    return () => clearTimeout(timer);
  }, [isConnected, volume]);

  const addLog = (type: LogEntry['type'], message: string) => {
    setLogs((prev) => [
      ...prev,
      { id: Math.random().toString(36).substring(7), type, message, timestamp: new Date() },
    ]);
  };

  const connect = async () => {
    if (!aiRef.current) {
      addLog('system', 'Cannot connect: AI client not initialized.');
      return;
    }

    setIsConnecting(true);
    addLog('system', 'Requesting microphone access...');

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true, // More permissive
      });
      
      const track = stream.getAudioTracks()[0];
      if (track) {
        addLog('system', `Using microphone: ${track.label}`);
      }
    } catch (err: any) {
      let errorMsg = `Microphone access denied: ${err.message}`;
      if (err.name === 'NotAllowedError' || err.message.includes('denied')) {
        errorMsg += '. Please check your browser and system settings to allow microphone access for this site.';
      }
      addLog('system', errorMsg);
      setIsConnecting(false);
      return;
    }

    addLog('system', 'Connecting to Gemini Live API...');

    try {
      const sessionPromise = aiRef.current.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          inputAudioTranscription: {}, // Enable user speech transcription
          outputAudioTranscription: {}, // Enable model speech transcription
          systemInstruction: 'You are a helpful voice assistant. You have access to skills like getting the weather and controlling smart lights. Keep your answers concise and conversational.',
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_current_weather',
                  description: 'Get the current weather in a given location',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      location: { type: Type.STRING, description: 'The city and state, e.g. San Francisco, CA' },
                      unit: { type: Type.STRING, enum: ['celsius', 'fahrenheit'] },
                    },
                    required: ['location'],
                  },
                },
                {
                  name: 'change_light_color',
                  description: 'Change the color of the smart lights in a room',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      room: { type: Type.STRING, description: 'The room to change the lights in' },
                      color: { type: Type.STRING, description: 'The color to change the lights to' },
                    },
                    required: ['room', 'color'],
                  },
                },
              ],
            },
          ],
        },
        callbacks: {
          onopen: () => {
            addLog('system', 'Connected! Start speaking...');
            setIsConnected(true);
            setIsConnecting(false);
            
            audioStreamerRef.current?.init();
            
            // Start recording and sending audio
            audioRecorderRef.current?.start((base64Data) => {
              sessionPromise.then((session) => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
                });
              });
            }, stream!, (v) => {
              // Smooth the volume display a bit
              setVolume(prev => prev * 0.7 + v * 0.3);
            }).catch(err => {
              addLog('system', `Audio processing error: ${err.message}`);
              disconnect();
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            const msg = message as any;
            // Handle user transcription
            if (msg.serverContent?.userTurn?.parts) {
              const userText = msg.serverContent.userTurn.parts
                .map((p: any) => p.text)
                .filter(Boolean)
                .join(' ');
              if (userText) {
                addLog('user', userText);
              }
            }

            // Handle model transcription and audio
            if (msg.serverContent?.modelTurn?.parts) {
              const modelText = msg.serverContent.modelTurn.parts
                .map((p: any) => p.text)
                .filter(Boolean)
                .join(' ');
              if (modelText) {
                addLog('model', modelText);
              }

              const base64Audio = msg.serverContent.modelTurn.parts
                .find((p: any) => p.inlineData)?.inlineData?.data;
              if (base64Audio) {
                audioStreamerRef.current?.play(base64Audio);
              }
            }

            // Handle interruption
            if (message.serverContent?.interrupted) {
              addLog('system', 'Model interrupted.');
              audioStreamerRef.current?.stop();
              audioStreamerRef.current?.init();
            }

            // Handle tool calls
            if (message.toolCall) {
              const responses = message.toolCall.functionCalls.map((call) => {
                addLog('tool', `Executing skill: ${call.name}(${JSON.stringify(call.args)})`);
                
                let result: any = { status: 'unknown_tool' };
                
                if (call.name === 'get_current_weather') {
                  const loc = (call.args as any).location || 'Unknown';
                  result = { weather: 'Sunny', temperature: '72', unit: 'fahrenheit', location: loc };
                  addLog('tool', `Result: ${JSON.stringify(result)}`);
                } else if (call.name === 'change_light_color') {
                  const room = (call.args as any).room || 'Unknown';
                  const color = (call.args as any).color || 'Unknown';
                  result = { status: 'success', room, color };
                  addLog('tool', `Result: ${JSON.stringify(result)}`);
                }
                
                return {
                  id: call.id,
                  name: call.name,
                  response: result,
                };
              });

              sessionPromise.then((session) => {
                session.sendToolResponse({ functionResponses: responses });
              });
            }
          },
          onclose: () => {
            addLog('system', 'Connection closed.');
            disconnect(false);
          },
          onerror: (error) => {
            addLog('system', `Error: ${error}`);
            disconnect(false);
          },
        },
      });

      sessionRef.current = sessionPromise;
    } catch (err: any) {
      addLog('system', `Failed to connect: ${err.message}`);
      setIsConnecting(false);
    }
  };

  const disconnect = (closeSession = true) => {
    audioRecorderRef.current?.stop();
    audioStreamerRef.current?.stop();
    
    if (closeSession && sessionRef.current) {
      sessionRef.current.then((session: any) => {
        try {
          session.close();
        } catch (e) {}
      });
    }
    
    sessionRef.current = null;
    setIsConnected(false);
    setIsConnecting(false);
    setVolume(0);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-500/20 p-2 rounded-lg">
            <Activity className="w-5 h-5 text-indigo-400" />
          </div>
          <h1 className="font-medium text-lg tracking-tight">Live Voice Agent</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          {isConnected ? (
            <span className="flex items-center gap-1.5 text-emerald-400 bg-emerald-400/10 px-2.5 py-1 rounded-full">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              Connected
            </span>
          ) : (
            <span className="flex items-center gap-1.5 bg-zinc-800 px-2.5 py-1 rounded-full">
              <span className="h-2 w-2 rounded-full bg-zinc-500"></span>
              Disconnected
            </span>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col max-w-4xl w-full mx-auto p-4 gap-6">
        
        {/* Controls */}
        <div className="flex flex-col items-center justify-center py-12 gap-6 bg-zinc-900/30 rounded-2xl border border-zinc-800/50">
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">Voice & Skills Demo</h2>
            <p className="text-zinc-400 max-w-md mx-auto">
              Talk to the agent naturally. Ask it about the weather or tell it to change the lights to see skills in action.
            </p>
          </div>
          
          <button
            onClick={isConnected ? () => disconnect() : connect}
            disabled={isConnecting}
            className={`
              relative group flex items-center justify-center w-24 h-24 rounded-full transition-all duration-300 z-10
              ${isConnected 
                ? 'bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/30' 
                : 'bg-indigo-500 hover:bg-indigo-600 text-white shadow-lg shadow-indigo-500/25'
              }
              ${isConnecting ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            {isConnected ? (
              <MicOff className="w-8 h-8" />
            ) : (
              <Mic className="w-8 h-8" />
            )}
            
            {/* Pulsating ring based on volume */}
            {isConnected && (
              <div 
                className="absolute inset-0 rounded-full border-4 border-indigo-500/40 transition-transform duration-75"
                style={{ 
                  transform: `scale(${1 + volume * 2.5})`,
                  opacity: 0.2 + volume * 0.8
                }}
              ></div>
            )}
          </button>

          {/* Volume Meter Bar */}
          {isConnected && (
            <div className="w-48 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div 
                className="h-full bg-indigo-500 transition-all duration-75"
                style={{ width: `${Math.min(100, volume * 500)}%` }}
              ></div>
            </div>
          )}
          
          <div className="text-sm font-medium text-zinc-500">
            {isConnecting ? 'Connecting...' : isConnected ? 'Tap to stop' : 'Tap to start speaking'}
          </div>

          {showMicHint && (
            <div className="mt-4 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl max-w-md animate-in fade-in slide-in-from-top-2">
              <div className="flex gap-3 text-amber-200 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <div className="space-y-1">
                  <p className="font-semibold">音声が検出されません</p>
                  <ul className="list-disc list-inside opacity-80 space-y-1 text-xs">
                    <li>正しいマイクが選択されているか確認してください</li>
                    <li>OSの設定でマイクがミュートになっていないか確認してください</li>
                    <li>他のアプリがマイクを独占していないか確認してください</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Logs Terminal */}
        <div className="flex-1 flex flex-col bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden min-h-[300px]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-950/50">
            <Terminal className="w-4 h-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-400">Activity Log</span>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-sm">
            {logs.length === 0 ? (
              <div className="text-zinc-600 text-center py-8">No activity yet. Connect to start.</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex gap-3 items-start">
                  <span className="text-zinc-600 shrink-0 mt-0.5">
                    {log.timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  
                  {log.type === 'system' && (
                    <span className="text-zinc-400 flex-1">{log.message}</span>
                  )}
                  {log.type === 'tool' && (
                    <span className="text-emerald-400 flex-1 flex items-start gap-2">
                      <Settings className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{log.message}</span>
                    </span>
                  )}
                  {log.type === 'user' && (
                    <span className="text-indigo-400 flex-1">
                      <span className="font-bold mr-2">You:</span>
                      {log.message}
                    </span>
                  )}
                  {log.type === 'model' && (
                    <span className="text-zinc-200 flex-1">
                      <span className="font-bold mr-2 text-indigo-300">AI:</span>
                      {log.message}
                    </span>
                  )}
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </main>
    </div>
  );
}
