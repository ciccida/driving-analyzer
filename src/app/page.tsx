"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { AlertTriangle, Car, Flag, Play, Square, Settings, CheckCircle2, MapPin } from "lucide-react";
import { cruiseLogo, cruiseMascot } from "../images";

type Mode = "Street" | "Track";
type ViewState = "setup" | "measuring" | "result";

interface GDataPoint {
  x: number; // Lateral G (Left/Right)
  y: number; // Accel/Brake G (Forward/Backward)
  time: number;
}

const LOW_PASS_ALPHA = 0.2; // Smoothing factor for low-pass filter

export default function Home() {
  const [viewState, setViewState] = useState<ViewState>("setup");
  const [mode, setMode] = useState<Mode>("Street");
  const [trackScale, setTrackScale] = useState<number>(2.5);
  
  // Sensor State
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [gravity, setGravity] = useState({ x: 0, y: 0, z: 9.8 }); // 3D gravity vector
  const [gData, setGData] = useState<GDataPoint[]>([]);
  
  // ラップタイマー用のステート
  const [lapStartTime, setLapStartTime] = useState<number | null>(null);
  const [currentLapTime, setCurrentLapTime] = useState<number>(0);
  const [lastLapTime, setLastLapTime] = useState<number | null>(null);
  const [bestLapTime, setBestLapTime] = useState<number | null>(null);
  const [laps, setLaps] = useState<number[]>([]);
  
  // GPS & Lap trigger states
  const [targetLocation, setTargetLocation] = useState<{lat: number, lng: number} | null>(null);
  const [lastLapTriggerTime, setLastLapTriggerTime] = useState<number>(0);
  
  // Utility to calculate distance in meters
  const getDistanceInM = useCallback((lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c;
  }, []);

  // Real-time measurement state
  const [currentG, setCurrentG] = useState({ x: 0, y: 0 });
  const [maxG, setMaxG] = useState(0);
  const historyRef = useRef<GDataPoint[]>([]);
  const animationRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Smooth values for calibration
  const smoothRawRef = useRef({ x: 0, y: 0, z: 9.8 });

  // Result state
  const [jerkScore, setJerkScore] = useState(0);

  // ----------------------------------------------------------------------
  // Setup & Permissions
  // ----------------------------------------------------------------------
  useEffect(() => {
    if (typeof (DeviceMotionEvent as any) !== 'undefined' && typeof (DeviceMotionEvent as any).requestPermission === 'function') {
      setPermissionGranted(false);
    } else {
      setPermissionGranted(true);
    }
  }, []);

  const requestPermission = () => {
    if (typeof (DeviceMotionEvent as any) !== 'undefined' && typeof (DeviceMotionEvent as any).requestPermission === 'function') {
      (DeviceMotionEvent as any).requestPermission()
        .then((response: string) => {
          if (response == 'granted') {
            setPermissionGranted(true);
          } else {
            alert("センサーアクセスが拒否されました");
          }
        })
        .catch(console.error);
    } else {
      setPermissionGranted(true);
    }
  };

  const calibrateZero = () => {
    setGravity({
      x: smoothRawRef.current.x,
      y: smoothRawRef.current.y,
      z: smoothRawRef.current.z
    });
    alert("キャリブレーション完了: スマホの傾きを考慮してゼロ点を設定しました。");
  };
  
  const setStartFinishLine = () => {
    if (!navigator.geolocation) {
      alert("GPS機能がサポートされていません。");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setTargetLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        alert(`スタートラインを設定しました！\n緯度: ${pos.coords.latitude.toFixed(4)}\n経度: ${pos.coords.longitude.toFixed(4)}\n\nテスト時はこの地点の半径20m以内で自動ラップが計測されます。`);
      },
      (err) => alert("位置情報の取得に失敗しました。GPSをオンにしてください。"),
      { enableHighAccuracy: true }
    );
  };

  const stopMeasurement = () => {
    setViewState("result");
    setLapStartTime(null);
    calculateResult();
  };

  // ラップタイマー処理
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (viewState === "measuring" && mode === "Track" && lapStartTime !== null) {
      interval = setInterval(() => {
        setCurrentLapTime(Date.now() - lapStartTime);
      }, 30); // 30ms updates for UI
    }
    return () => clearInterval(interval);
  }, [viewState, mode, lapStartTime]);

  const triggerLap = useCallback((triggerTime?: number) => {
    const now = triggerTime || Date.now();
    if (lapStartTime === null) {
      setLapStartTime(now);
    } else {
      const lapTime = now - lapStartTime;
      setLastLapTime(lapTime);
      setLaps(prev => [...prev, lapTime]);
      if (bestLapTime === null || lapTime < bestLapTime) {
        setBestLapTime(lapTime);
      }
      setLapStartTime(now);
      setCurrentLapTime(0);
    }
  }, [lapStartTime, bestLapTime]);

  // GPS監視処理
  useEffect(() => {
    if (viewState !== "measuring" || mode !== "Track" || !targetLocation) return;
    
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const dist = getDistanceInM(latitude, longitude, targetLocation.lat, targetLocation.lng);
        const now = Date.now();
        // 半径20メートル以内に入り、かつ前回のラップから10秒以上経過している場合
        if (dist < 20 && now - lastLapTriggerTime > 10000) {
          triggerLap(now);
          setLastLapTriggerTime(now);
        }
      },
      (error) => console.error("GPS Watch Error:", error),
      { enableHighAccuracy: true }
    );
    
    return () => navigator.geolocation.clearWatch(watchId);
  }, [viewState, mode, targetLocation, lastLapTriggerTime, triggerLap, getDistanceInM]);

  const formatTime = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const millis = ms % 1000;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
  };

  const startMeasurement = () => {
    if (!permissionGranted) {
      alert("センサーアクセスを許可してください");
      return;
    }
    setGData([]);
    historyRef.current = [];
    setMaxG(0);
    setViewState("measuring");
    setLapStartTime(null);
    setCurrentLapTime(0);
    setLastLapTime(null);
    setBestLapTime(null);
    setLaps([]);
  };

  // ----------------------------------------------------------------------
  // Sensor Data Processing (3D Projection)
  // ----------------------------------------------------------------------
  useEffect(() => {
    if (!permissionGranted) return;

    let sX = smoothRawRef.current.x;
    let sY = smoothRawRef.current.y;
    let sZ = smoothRawRef.current.z;

    const handleMotion = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity;
      if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

      // Apply low-pass filter
      sX = LOW_PASS_ALPHA * acc.x + (1 - LOW_PASS_ALPHA) * sX;
      sY = LOW_PASS_ALPHA * acc.y + (1 - LOW_PASS_ALPHA) * sY;
      sZ = LOW_PASS_ALPHA * acc.z + (1 - LOW_PASS_ALPHA) * sZ;
      smoothRawRef.current = { x: sX, y: sY, z: sZ };

      // 1. Calculate UP unit vector (gravity)
      const gMag = Math.sqrt(gravity.x ** 2 + gravity.y ** 2 + gravity.z ** 2) || 9.8;
      const up = { x: gravity.x / gMag, y: gravity.y / gMag, z: gravity.z / gMag };

      // 2. Dynamic acceleration (remove gravity)
      const dX = sX - gravity.x;
      const dY = sY - gravity.y;
      const dZ = sZ - gravity.z;

      // 3. Find RIGHT vector on the horizontal plane
      // Assuming phone's X axis (1,0,0) is roughly "Right" (Portrait mode)
      const dotX = 1 * up.x; 
      let rX = 1 - dotX * up.x;
      let rY = 0 - dotX * up.y;
      let rZ = 0 - dotX * up.z;
      
      const rMag = Math.sqrt(rX ** 2 + rY ** 2 + rZ ** 2);
      if (rMag > 0.001) {
        rX /= rMag; rY /= rMag; rZ /= rMag;
      } else {
        // Fallback if phone is perfectly sideways (landscape)
        rX = 1; rY = 0; rZ = 0;
      }

      // 4. Find FORWARD vector (UP x RIGHT)
      const fX = up.y * rZ - up.z * rY;
      const fY = up.z * rX - up.x * rZ;
      const fZ = up.x * rY - up.y * rX;

      // 5. Project dynamic acceleration
      // Invert forward/right depending on axis handedness (Forward is -Z in device coords, so we negate if needed)
      // Actually right-hand rule gives us the exact vectors.
      const forwardG = -(dX * fX + dY * fY + dZ * fZ) / 9.8;
      const rightG = (dX * rX + dY * rY + dZ * rZ) / 9.8;

      if (viewState === "measuring") {
        setCurrentG({ x: rightG, y: forwardG });

        const totalG = Math.sqrt(rightG ** 2 + forwardG ** 2);
        if (totalG > maxG) {
          setMaxG(totalG);
        }

        historyRef.current.push({
          x: rightG,
          y: forwardG,
          time: performance.now()
        });
      }
    };

    window.addEventListener("devicemotion", handleMotion);
    return () => {
      window.removeEventListener("devicemotion", handleMotion);
    };
  }, [permissionGranted, viewState, gravity, maxG]);

  // ----------------------------------------------------------------------
  // GG Diagram Rendering
  // ----------------------------------------------------------------------
  useEffect(() => {
    if (viewState !== "measuring" || !canvasRef.current) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) / 2 - 20;

      const scaleG = mode === "Street" ? 0.5 : trackScale;

      ctx.clearRect(0, 0, width, height);

      // Draw Grid
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 1;
      
      // Circles
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius * (i / 4), 0, Math.PI * 2);
        ctx.stroke();
      }
      
      // Crosshairs
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, height);
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.stroke();

      // Labels
      ctx.fillStyle = "#64748b";
      ctx.font = "12px sans-serif";
      ctx.fillText(`${scaleG}G`, centerX + radius - 20, centerY - 5);
      ctx.fillText(`Accel`, centerX + 5, 20);
      ctx.fillText(`Brake`, centerX + 5, height - 10);

      // Draw History Trail
      const now = performance.now();
      ctx.beginPath();
      let hasStarted = false;
      
      for (let i = historyRef.current.length - 1; i >= 0; i--) {
        const point = historyRef.current[i];
        const age = now - point.time;
        if (age > 2000) break; // 2 seconds trail

        const px = centerX + (point.x / scaleG) * radius;
        const py = centerY - (point.y / scaleG) * radius; // Invert Y for UI (Accel UP)

        if (!hasStarted) {
          ctx.moveTo(px, py);
          hasStarted = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.strokeStyle = "rgba(219, 39, 119, 0.5)"; // Pink trail
      ctx.lineWidth = 3;
      ctx.stroke();

      // Draw Current Pointer
      const cx = centerX + (currentG.x / scaleG) * radius;
      const cy = centerY - (currentG.y / scaleG) * radius;
      
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#EF4444"; // Red dot
      ctx.fill();

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [viewState, currentG, mode, trackScale]);

  // ----------------------------------------------------------------------
  // Result Calculation
  // ----------------------------------------------------------------------
  const calculateResult = () => {
    const history = historyRef.current;
    if (history.length < 2) return;

    let jerkPenalty = 0;
    let highGCount = 0;
    let totalGSum = 0;

    for (let i = 1; i < history.length; i++) {
      const p1 = history[i - 1];
      const p2 = history[i];
      const dt = (p2.time - p1.time) / 1000; // seconds

      if (dt > 0) {
        const dG = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
        const jerk = dG / dt;
        
        // Accumulate penalty for rough movements (jerk > 0.5 G/s)
        if (jerk > 0.5) {
          jerkPenalty += (jerk - 0.5) * dt;
        }

        const currentG = Math.sqrt(p2.x ** 2 + p2.y ** 2);
        if (currentG > 0.5) {
          highGCount++;
          totalGSum += currentG;
        }
      }
    }
    
    let score = 100;

    if (mode === "Street") {
      // Street mode heavily penalizes sudden G changes (shakes)
      // 1 penalty point per 1.0 accumulated jerk penalty
      score = 100 - (jerkPenalty * 15);
    } else {
      // Track mode: Rewards high G usage but penalizes rough handling
      // Base score 70, add up to 30 for high G, subtract for jerk
      const avgHighG = highGCount > 0 ? totalGSum / highGCount : 0;
      const gBonus = Math.min(30, avgHighG * 20); 
      score = 70 + gBonus - (jerkPenalty * 5);
    }

    setJerkScore(Math.max(0, Math.min(100, Math.round(score))));
  };


  // ----------------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------------
  if (viewState === "setup") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 max-w-md mx-auto space-y-8">
        <div className="text-center space-y-2">
          <div className="flex justify-center mb-4">
            <img 
              src={cruiseLogo} 
              alt="SHAKE YOUR LIFE CRUISE" 
              width={280} 
              height={100} 
              className="drop-shadow-[0_0_15px_rgba(232,0,107,0.5)]"
            />
          </div>
          <p className="text-pink-400 font-black tracking-[0.2em] text-xl drop-shadow-md">
            G-METER & ANALYZER
          </p>
        </div>

        {/* Mode Selector */}
        <div className="w-full bg-gray-900 rounded-2xl p-1 flex relative">
          <div 
            className={`absolute top-1 bottom-1 w-1/2 bg-pink-600 rounded-xl transition-transform duration-300 ${mode === "Track" ? "translate-x-[calc(100%-8px)]" : "translate-x-0"}`} 
          />
          <button 
            className="flex-1 py-3 flex items-center justify-center gap-2 relative z-10 font-semibold text-white"
            onClick={() => setMode("Street")}
          >
            <Car size={18} /> Street
          </button>
          <button 
            className="flex-1 py-3 flex items-center justify-center gap-2 relative z-10 font-semibold text-white"
            onClick={() => setMode("Track")}
          >
            <Flag size={18} /> Track
          </button>
        </div>

        {mode === "Track" && (
          <div className="w-full space-y-2">
            <label className="text-sm text-gray-400 font-medium">スケール設定</label>
            <select 
              value={trackScale} 
              onChange={e => setTrackScale(Number(e.target.value))}
              className="w-full bg-gray-900 border border-gray-800 rounded-xl p-3 text-white appearance-none"
            >
              <option value={1.5}>1.5 G</option>
              <option value={2.0}>2.0 G</option>
              <option value={2.5}>2.5 G</option>
              <option value={3.0}>3.0 G</option>
            </select>
          </div>
        )}

        <div className="bg-yellow-900/60 border border-yellow-500 rounded-xl p-4 flex items-start gap-3 w-full shadow-lg">
          <AlertTriangle className="text-yellow-400 shrink-0 mt-0.5" size={20} />
          <p className="text-sm text-yellow-100 font-medium leading-relaxed">
            運転中のスマホ操作は厳禁です。Trackモードは必ずサーキット等のクローズドコースで使用してください。
          </p>
        </div>

        <div className="w-full space-y-4 pt-4">
          {!permissionGranted ? (
            <button 
              onClick={requestPermission}
              className="w-full bg-gray-800 hover:bg-gray-700 py-4 rounded-xl font-bold transition-colors text-white"
            >
              センサーのアクセス許可
            </button>
          ) : (
            <>
              <button 
                onClick={calibrateZero}
                className="w-full bg-gray-800 hover:bg-gray-700 py-4 rounded-xl font-bold flex justify-center items-center gap-2 transition-colors text-white"
              >
                <Settings size={18} />
                水平ゼロ点調整
              </button>

              {mode === "Track" && (
                <button 
                  onClick={setStartFinishLine}
                  className="w-full bg-gray-800 border border-pink-500/30 hover:bg-gray-700 py-4 rounded-xl font-bold flex justify-center items-center gap-2 transition-colors text-pink-300"
                >
                  <MapPin size={18} />
                  現在地をスタートラインに設定 (GPS)
                </button>
              )}
              
              <button 
                onClick={startMeasurement}
                className="w-full bg-pink-600 hover:bg-pink-500 py-4 rounded-xl font-bold text-lg flex justify-center items-center gap-2 transition-colors shadow-[0_0_20px_rgba(219,39,119,0.4)] text-white"
              >
                <Play size={20} fill="currentColor" />
                計測開始
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (viewState === "measuring") {
    const totalG = Math.sqrt(currentG.x * currentG.x + currentG.y * currentG.y);
    return (
      <div className="flex flex-col h-screen p-4">
        <div className="flex justify-between items-center mb-6">
          <div className="flex flex-col">
            <span className="text-gray-400 text-xs font-bold uppercase tracking-wider">Mode</span>
            <span className="font-semibold text-lg">{mode} {mode === "Street" ? "(0.5G)" : `(${trackScale}G)`}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-gray-400 text-xs font-bold uppercase tracking-wider">Max G</span>
            <span className="font-semibold text-lg text-red-400">{maxG.toFixed(2)} G</span>
          </div>
        </div>

        <div className={`flex-1 flex justify-center items-center relative ${mode === "Track" ? "min-h-[220px]" : "min-h-[300px]"}`}>
          <canvas 
            ref={canvasRef}
            width={mode === "Track" ? 220 : 300}
            height={mode === "Track" ? 220 : 300}
            className="rounded-full bg-gray-900/50 shadow-inner"
          />
        </div>

        {mode === "Track" && (
          <div className="flex-1 flex flex-col items-center justify-center bg-gray-900 rounded-3xl border border-pink-900/50 p-4 mb-4 shadow-[0_0_20px_rgba(219,39,119,0.1)]">
            <div className="text-pink-500 text-xs font-bold tracking-widest mb-1">CURRENT LAP</div>
            <div className="text-5xl font-mono font-black tracking-tight text-white mb-4 drop-shadow-md">
               {formatTime(currentLapTime)}
            </div>
            
            <div className="flex gap-3 w-full mb-3">
               <div className="flex-1 bg-gray-950 rounded-2xl p-3 text-center border border-gray-800">
                 <div className="text-gray-500 text-xs font-bold mb-1">BEST LAP</div>
                 <div className="font-mono text-2xl text-pink-400 font-bold tracking-tight">{bestLapTime !== null ? formatTime(bestLapTime) : "--:--.---"}</div>
               </div>
               <div className="flex-1 bg-gray-950 rounded-2xl p-3 text-center border border-gray-800">
                 <div className="text-gray-500 text-xs font-bold mb-1">LAST LAP</div>
                 <div className="font-mono text-2xl text-gray-200 tracking-tight">{lastLapTime !== null ? formatTime(lastLapTime) : "--:--.---"}</div>
               </div>
            </div>

            <div className="w-full mb-3">
              {laps.length === 0 ? (
                <div className="text-gray-600 text-sm text-center py-2 font-medium">Laps will appear here</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {laps.map((lap, index) => (
                    <div key={index} className="flex justify-between items-center text-lg font-mono px-3 py-2 rounded-xl bg-gray-950 border border-gray-800 shadow-sm">
                      <span className="text-gray-400 font-bold">Lap {index + 1}</span>
                      <span className={lap === bestLapTime ? "text-pink-400 font-black" : "text-gray-200 font-bold"}>{formatTime(lap)}</span>
                    </div>
                  )).slice(-3).reverse()}
                </div>
              )}
            </div>

            <button 
              onClick={() => triggerLap()}
              className="w-full bg-gray-800/50 hover:bg-gray-700/50 border border-gray-600/30 text-gray-400 py-2 rounded-xl font-medium transition-colors flex items-center justify-center gap-2 text-sm"
            >
              <Flag size={14} />
              手動ラップ (バックアップ用)
            </button>
          </div>
        )}

        {mode === "Street" && (
          <div className="grid grid-cols-3 gap-2 mb-8 text-center bg-gray-900/50 rounded-2xl p-4">
            <div>
              <div className="text-gray-500 text-xs mb-1">Lat G</div>
              <div className="font-mono text-xl">{Math.abs(currentG.x).toFixed(2)}</div>
            </div>
            <div className="border-x border-gray-800">
              <div className="text-gray-500 text-xs mb-1">Accel G</div>
              <div className="font-mono text-xl">{currentG.y.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-gray-500 text-xs mb-1">Total G</div>
              <div className="font-mono text-xl text-blue-400 font-bold">{totalG.toFixed(2)}</div>
            </div>
          </div>
        )}

        <button 
          onClick={stopMeasurement}
          className={`w-full bg-red-600 hover:bg-red-500 py-5 rounded-2xl font-bold text-lg flex justify-center items-center gap-2 ${mode === "Track" ? "mb-2" : "mb-8"}`}
        >
          <Square size={20} fill="currentColor" />
          計測終了＆診断
        </button>
      </div>
    );
  }

  if (viewState === "result") {
    return (
      <div className="flex flex-col min-h-screen p-6 max-w-md mx-auto">
        <h2 className="text-2xl font-bold mb-6 text-center text-white">走行診断レポート</h2>
        
        <div className="bg-gray-900 rounded-3xl p-6 mb-6 text-center border border-pink-900/50 relative overflow-hidden flex flex-col items-center">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-pink-500 to-rose-500" />
          
          <div className="flex justify-center items-end gap-4 mb-2">
            <img 
              src={cruiseMascot} 
              alt="CRUISE Mascot" 
              width={80} 
              height={80} 
              className="drop-shadow-lg"
            />
            <div className="flex flex-col items-center">
              <h3 className="text-gray-400 text-sm font-bold uppercase tracking-wider mb-1">総合スコア</h3>
              <div className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-pink-200">
                {jerkScore}
              </div>
            </div>
          </div>
          <p className="text-sm text-pink-400 font-bold mt-2">/ 100 pt</p>
        </div>

        <div className="space-y-4 mb-8">
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
            <h4 className="font-bold mb-2 flex items-center gap-2 text-white">
              <CheckCircle2 size={18} className="text-pink-500" />
              AI フィードバック
            </h4>
            <p className="text-sm text-gray-300 leading-relaxed">
              {mode === "Street" 
                ? jerkScore > 80 ? "非常にスムーズな運転です。同乗者も快適に過ごせる素晴らしいペダルワーク・ステアリング操作です。" : "少し加減速のG変化（ジャーク）が大きめです。もう少しブレーキのリリースをゆっくり行うとよりスムーズになります。"
                : "荷重移動のメリハリはありますが、旋回中のGの変動が見られます。ステアリングの切り足しやアクセルのオンオフを減らし、一定の定常円旋回を意識しましょう。"}
            </p>
          </div>
        </div>

        <div className="mt-auto space-y-4">
          <div className="bg-pink-900/20 border border-pink-600/50 rounded-2xl p-5 text-center shadow-[0_0_15px_rgba(219,39,119,0.2)]">
            <p className="text-sm text-pink-100 font-medium leading-relaxed mb-3">
              アライメント調整や足回りのセッティングの<br />ご相談は下記リンクからぜひ！
            </p>
            <a 
              href="https://cruise-power.co.jp/" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="inline-block w-full bg-pink-600 hover:bg-pink-500 text-white font-bold py-3 rounded-xl transition-colors"
            >
              CRUISE 公式サイトへ
            </a>
          </div>

          <button 
            onClick={() => setViewState("setup")}
            className="w-full bg-gray-800 hover:bg-gray-700 py-4 rounded-xl font-bold text-white transition-colors"
          >
            トップに戻る
          </button>
        </div>
      </div>
    );
  }

  return null;
}
