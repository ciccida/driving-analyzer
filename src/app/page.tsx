"use client";
import html2canvas from "html2canvas";

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

const LOW_PASS_ALPHA = 0.06; // Smoothing factor for low-pass filter

export default function Home() {
  const [viewState, setViewState] = useState<ViewState>("setup");
  const [mode, setMode] = useState<Mode>("Street");
  const [trackScale, setTrackScale] = useState<number>(2.5);
  
  // Sensor State
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [gravity, setGravity] = useState({ x: 0, y: 0, z: 9.8 }); // 3D gravity vector
  const [gData, setGData] = useState<GDataPoint[]>([]);
  const wakeLockRef = useRef<any>(null);

  
  // ラップタイマー用のステート
  const [lapStartTime, setLapStartTime] = useState<number | null>(null);
  const [currentLapTime, setCurrentLapTime] = useState<number>(0);
  const [lastLapTime, setLastLapTime] = useState<number | null>(null);
  const [bestLapTime, setBestLapTime] = useState<number | null>(null);
  const [laps, setLaps] = useState<number[]>([]);
  
  // GPS & Lap trigger states
  const [targetLocation, setTargetLocation] = useState<{lat: number, lng: number} | null>(null);
  const [lastLapTriggerTime, setLastLapTriggerTime] = useState<number>(0);
  const recentGpsPoints = useRef<{time: number, dist: number}[]>([]);
  
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
  const [aiFeatures, setAiFeatures] = useState<any>(null);
  const [aiFeedback, setAiFeedback] = useState<string>("");
  const [lapResults, setLapResults] = useState<any[]>([]);
  const [selectedLapIndex, setSelectedLapIndex] = useState<number | 'ALL'>('ALL');
  const lapIndicesRef = useRef<number[]>([]);

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
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(console.error);
      wakeLockRef.current = null;
    }
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
      lapIndicesRef.current.push(historyRef.current.length);
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
    
    // Clear recent points on start
    recentGpsPoints.current = [];
    
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        // Use position.timestamp for maximum precision, fallback to Date.now()
        const now = position.timestamp || Date.now();
        const dist = getDistanceInM(latitude, longitude, targetLocation.lat, targetLocation.lng);
        
        recentGpsPoints.current.push({ time: now, dist });
        if (recentGpsPoints.current.length > 5) {
          recentGpsPoints.current.shift();
        }

        const pts = recentGpsPoints.current;
        if (pts.length >= 3) {
          const p1 = pts[pts.length - 3];
          const p2 = pts[pts.length - 2];
          const p3 = pts[pts.length - 1];

          // 判定: V字型に距離が変化した（p2が最接近点）、かつターゲット付近（例: 40m以内）
          if (p2.dist < 40 && p1.dist > p2.dist && p3.dist > p2.dist) {
            // パラボラ近似 (二次補間) で真の最接近時間(t_min)を計算する
            const t1 = p1.time;
            const t2 = p2.time;
            const t3 = p3.time;

            const x1 = t1 - t2;
            const x3 = t3 - t2;
            
            const y1 = p1.dist * p1.dist;
            const y2 = p2.dist * p2.dist;
            const y3 = p3.dist * p3.dist;

            const dy1 = y1 - y2;
            const dy3 = y3 - y2;

            const denom = x1 * x3 * (x1 - x3);
            if (denom !== 0) {
              const a = (dy1 * x3 - dy3 * x1) / denom;
              const b = (dy1 * x3 * x3 - dy3 * x1 * x1) / (x1 * x3 * (x3 - x1));

              let t_min = t2;
              if (a > 0) {
                // b / (2a)
                let x_min = -b / (2 * a);
                // 補間結果が範囲外に飛ぶのを防ぐ
                x_min = Math.max(x1, Math.min(x3, x_min));
                t_min = t2 + x_min;
              }

              if (Date.now() - lastLapTriggerTime > 10000) {
                triggerLap(t_min);
                setLastLapTriggerTime(Date.now());
                // 重複トリガー防止のために履歴をクリア
                recentGpsPoints.current = [];
              }
            }
          }
        }
      },
      (error) => console.error("GPS Watch Error:", error),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
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
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(lock => {
        wakeLockRef.current = lock;
      }).catch(err => console.error(err));
    }
    setLapStartTime(null);
    setCurrentLapTime(0);
    setLastLapTime(null);
    setBestLapTime(null);
    setLaps([]);
    lapIndicesRef.current = [0];
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
  const generateProceduralAdvice = (features: any) => {
    // Helper to pick random item from array
    const sample = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

    let review = "";
    if (features.score >= 90) review = sample([
      "非常に丁寧で完成されたドライビングです。素晴らしい荷重コントロールです。",
      "プロレベルの極めてスムーズなペダルワークです。無駄な挙動が一切ありません。",
      "Gの変動が極めて少なく、車体にも同乗者にも優しい完璧な走行です。"
    ]);
    else if (features.score >= 75) review = sample([
      "全体的にスムーズな操作ができていますが、一部でGの変動が見られます。",
      "安定した良い走りですが、要所で少し操作が急になる場面がありました。",
      "基本は丁寧に操作できていますが、さらに滑らかさを追求できる余地があります。"
    ]);
    else review = sample([
      "操作が急になっており、車体や同乗者に負担がかかる走りになっています。",
      "加減速やステアリングのG変化が大きく、タイヤへの負担が大きい状態です。",
      "少し荒い操作が目立ちます。各ペダルとハンドルの操作をよりゆっくり行う意識を持ちましょう。"
    ]);

    let goodPoints = [];
    if (features.smoothRatio > 0.8) goodPoints.push(sample(["走行中の荷重変化が非常に滑らかに保たれています。", "基本となる加減速のG移動がとても丁寧です。"]));
    if (features.steadyCorneringTime > 2.0) goodPoints.push(sample(["旋回中のGが安定しており、綺麗な定常円旋回が維持できています。", "コーナーでのステアリング舵角が一定に保たれており、美しいコーナリングです。"]));
    if (features.lateBrakeReleaseCount === 0 && features.hardBrakeCount === 0) goodPoints.push(sample(["停止直前のブレーキの抜き取りが完璧で、不快なカックンブレーキがありません。", "ブレーキのリリースが非常に上手く、スーッと停止できています。"]));
    if (goodPoints.length === 0) goodPoints.push(sample(["一定の速度を維持しようとする意識は見られます。", "直線でのアクセルワークは比較的安定しています。"]));

    let badPoints = [];
    if (features.hardBrakeCount > 0) badPoints.push(sample([`急ブレーキが ${features.hardBrakeCount} 回検出されました。さらに手前からブレーキを優しく踏み始めましょう。`, `${features.hardBrakeCount} 回の強いブレーキングがありました。同乗者の頭が前後に揺れないペダルワークを意識してください。`]));
    if (features.sharpSteeringCount > 0) badPoints.push(sample([`急なステアリング操作が ${features.sharpSteeringCount} 回ありました。コーナー手前での減速を終わらせ、ゆっくり切り込みましょう。`, `${features.sharpSteeringCount} 回、ハンドルの切り足し・戻しが急な場面がありました。`]));
    if (features.lateBrakeReleaseCount > 0) badPoints.push(sample([`停止時のブレーキ残し（カックンブレーキ）が ${features.lateBrakeReleaseCount} 回あります。停止する瞬間にペダルを数ミリ戻す意識を持ちましょう。`, `完全停止時にGが残っている場面が ${features.lateBrakeReleaseCount} 回ありました。スーッとGを抜くように停まると完璧です。`]));
    if (badPoints.length === 0) badPoints.push(sample(["大きな減点イベントはありません。この調子でさらにミリ単位のペダルワークを極めましょう。", "安全で素晴らしい運転です。次はタイヤのグリップ変化を感じ取りながら走ってみてください。"]));

    let setupAdvice = "";
    if (features.mode === "Track") {
      setupAdvice = sample([
        "高いG領域を使えています。タイヤの空気圧を高めにセットするか、キャンバー角の見直しでさらにグリップを引き出せます。",
        "サーキット走行に耐えうる足回りセッティング（車高調やアライメント）について、ぜひCRUISEにご相談ください！"
      ]);
    } else {
      if (features.hardBrakeCount > 2) setupAdvice = sample([
        "フロントタイヤへの負担が大きい走りです。フロントの空気圧を少し高めにするか、サスの減衰を少し硬めにするとノーズダイブが抑えられます。",
        "ブレーキング時の姿勢変化が大きいため、ブレーキパッドの摩耗点検や、足回りのリフレッシュをおすすめします。"
      ]);
      else if (features.sharpSteeringCount > 2) setupAdvice = sample([
        "ステアリングの反応が過敏になっています。アライメント（トー）がアウトに振れている可能性があるので確認をおすすめします。",
        "コーナリング時のロールが気になりませんか？スタビライザーの強化やアライメント調整で劇的に改善する可能性があります。"
      ]);
      else setupAdvice = sample([
        "現在の走りは車にとても優しいです。このままの足回りセッティングで心地よいドライブをお楽しみください。定期点検の際はお気軽にお越しください！",
        "非常にスムーズな荷重移動です。もし「もっと路面のインフォメーションが欲しい」と感じたら、ブッシュ類の強化などをご提案可能です。"
      ]);
    }

    const aiText = `【総評】\n${review}\n\n【良かったポイント】\n${goodPoints.join(" ")}\n\n【減点理由と改善のコツ】\n${badPoints.join(" ")}\n\n【愛車・セッティングへの一言】\n${setupAdvice}`;
    
    setAiFeedback(aiText);
  };

  const calculateResult = () => {
    const history = historyRef.current;
    if (history.length < 2) return;

    const calcScoreAndMaxG = (data: typeof historyRef.current) => {
      let movingTime = 0;
      let maxG = 0;

      let smoothTime = 0;
      let bonusTime = 0;
      let penaltyEvents = 0;
      let isPenaltyCooldown = false;
      let penaltyCooldownTimer = 0;

      let jerkPenaltyTrack = 0;
      let highGCountTrack = 0;
      let totalGSumTrack = 0;

      // Advanced features for AI
      let hardBrakeCount = 0;
      let sharpSteeringCount = 0;
      let lateBrakeReleaseCount = 0;
      let steadyCorneringTime = 0;

      const applyDeadzone = (v: number) => Math.abs(v) < 0.03 ? 0 : v;

      for (let i = 1; i < data.length; i++) {
        const pCurrent = data[i];
        
        const cx = applyDeadzone(pCurrent.x);
        const cy = applyDeadzone(pCurrent.y);
        const currentG = Math.sqrt(cx**2 + cy**2);
        
        if (currentG > maxG) maxG = currentG;

        const dt = (pCurrent.time - data[i - 1].time) / 1000;
        if (dt <= 0) continue;

        if (currentG > 0.05) {
          movingTime += dt;
        }

        let lookbackIdx = i - 1;
        while (lookbackIdx > 0 && (pCurrent.time - data[lookbackIdx].time) < 400) {
          lookbackIdx--;
        }
        
        const pPast = data[lookbackIdx];
        const dtJerk = (pCurrent.time - pPast.time) / 1000;
        
        let jerk = 0;
        let jerkX = 0;
        let jerkY = 0;
        if (dtJerk > 0) {
          const px = applyDeadzone(pPast.x);
          const py = applyDeadzone(pPast.y);
          jerkX = Math.abs(cx - px) / dtJerk;
          jerkY = Math.abs(cy - py) / dtJerk;
          const dG = Math.sqrt((cx - px)**2 + (cy - py)**2);
          jerk = dG / dtJerk;
        }

        // Feature detection
        if (currentG > 0.05) {
          if (jerk < 0.25) smoothTime += dt;
          if (currentG >= 0.05 && currentG <= 0.3 && jerk < 0.15) bonusTime += dt;
          
          if (Math.abs(cx) > 0.1 && Math.abs(cx) < 0.25 && jerkX < 0.1) {
            steadyCorneringTime += dt;
          }
        }

        if (jerk > 0.4 && !isPenaltyCooldown) {
          penaltyEvents++;
          if (jerkY > 0.3 && cy > 0) hardBrakeCount++;
          else if (jerkX > 0.3) sharpSteeringCount++;
          
          isPenaltyCooldown = true;
          penaltyCooldownTimer = pCurrent.time;
        }
        if (isPenaltyCooldown && (pCurrent.time - penaltyCooldownTimer > 1000)) {
          isPenaltyCooldown = false;
        }

        // Late brake release check (stopping with high G)
        if (currentG < 0.05 && pPast.y > 0.1) {
          lateBrakeReleaseCount++;
        }

        if (jerk > 0.8) jerkPenaltyTrack += (jerk - 0.8) * dt;
        if (currentG > 0.5) {
          highGCountTrack++;
          totalGSumTrack += currentG;
        }
      }
      
      if (maxG < 0.15 || movingTime < 10.0) {
        return { score: -1, maxG };
      }
      
      let score = 100;
      if (mode === "Street") {
        const smoothRatio = movingTime > 0 ? (smoothTime / movingTime) : 0;
        const baseScore = 75 * smoothRatio;
        const bonusRatio = movingTime > 0 ? (bonusTime / movingTime) : 0;
        const bonusScore = Math.min(25, (bonusRatio / 0.3) * 25);
        const penalties = penaltyEvents * 4;
        score = baseScore + bonusScore - penalties;
      } else {
        const avgHighG = highGCountTrack > 0 ? totalGSumTrack / highGCountTrack : 0;
        const gBonus = Math.min(30, avgHighG * 20); 
        score = 70 + gBonus - (jerkPenaltyTrack * 5);
      }

      return { 
        score: Math.max(0, Math.min(100, Math.round(score))), 
        maxG, 
        movingTime, 
        smoothTime, 
        hardBrakeCount, 
        sharpSteeringCount, 
        lateBrakeReleaseCount, 
        steadyCorneringTime 
      };
    };

    const overall = calcScoreAndMaxG(history);
    setJerkScore(overall.score);

    if (overall.score !== -1) {
      const features = {
        mode,
        movingTime: overall.movingTime,
        maxG: overall.maxG,
        score: overall.score,
        hardBrakeCount: overall.hardBrakeCount,
        sharpSteeringCount: overall.sharpSteeringCount,
        lateBrakeReleaseCount: overall.lateBrakeReleaseCount,
        steadyCorneringTime: overall.steadyCorneringTime,
        smoothRatio: (overall.movingTime ?? 0) > 0 ? (overall.smoothTime ?? 0) / (overall.movingTime ?? 1) : 0
      };
      setAiFeatures(features);
      generateProceduralAdvice(features);
    } else {
      setAiFeatures(null);
      setAiFeedback("走行データが不足しています。実際に走行してから診断してください。");
    }

    const results = [];
    for (let i = 0; i < laps.length; i++) {
      const start = lapIndicesRef.current[i] || 0;
      const end = lapIndicesRef.current[i + 1] || history.length;
      const lapData = history.slice(start, end);
      const res = calcScoreAndMaxG(lapData);
      results.push({
        index: i + 1,
        time: laps[i],
        score: res.score,
        maxG: res.maxG,
        data: lapData
      });
    }
    setLapResults(results);
    setSelectedLapIndex('ALL');
  };


  // ----------------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------------

  // ----------------------------------------------------------------------
  // Result GG Diagram Component
  // ----------------------------------------------------------------------
  const ResultGGDiagram = ({ data }: { data: typeof historyRef.current }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      
      const width = canvas.width;
      const height = canvas.height;
      const radius = width / 2;
      const centerX = width / 2;
      const centerY = height / 2;
      const scaleG = trackScale; // max G

      ctx.clearRect(0, 0, width, height);

      // Draw Grid
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.lineWidth = 1;
      
      // Circles
      [0.5, 1.0, 1.5, 2.0].forEach(g => {
        if (g <= scaleG) {
          ctx.beginPath();
          ctx.arc(centerX, centerY, (g / scaleG) * radius, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
      
      // Heatmap drawing (scatter points)
      if (data.length === 0) return;
      
      ctx.fillStyle = "rgba(232, 0, 107, 0.4)";
      data.forEach(point => {
         const px = centerX + (point.x / scaleG) * radius;
         const py = centerY - (point.y / scaleG) * radius;
         ctx.beginPath();
         ctx.arc(px, py, 2, 0, Math.PI * 2);
         ctx.fill();
      });
      
    }, [data]);
    
    return <canvas ref={canvasRef} width={280} height={280} className="rounded-full bg-gray-900/50 shadow-inner mx-auto mb-4" />;
  };

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
        <div id="result-capture-area" className="flex flex-col gap-6 bg-black p-2 pb-6 -mx-2 px-2 rounded-3xl">
          <div className="flex items-center justify-center gap-2 mb-2 pt-4">
            <h2 className="text-2xl font-bold text-center text-white">走行診断レポート</h2>
          </div>
        
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
                {jerkScore === -1 ? "-" : jerkScore}
              </div>
            </div>
          </div>
          {jerkScore === -1 && (
            <div className="text-sm text-red-400 mt-2 font-bold">走行データが不足しています（停車中など）</div>
          )}
          <p className="text-sm text-pink-400 font-bold mt-2">/ 100 pt</p>
        </div>

        <div className="space-y-4 mb-8">
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
            <h4 className="font-bold mb-2 flex items-center gap-2 text-white">
              <CheckCircle2 size={18} className="text-pink-500" />
              AI フィードバック
            </h4>
            <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
              {aiFeedback || "走行データが不足しています。実際に走行してから診断してください。"}
            </div>
            {aiFeatures && (
              <div className="mt-4 p-3 bg-gray-950 rounded-xl border border-gray-800">
                <p className="text-xs text-gray-500 mb-2">💡AIへ送信した抽出データ（デバッグ表示）</p>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono text-gray-400">
                  <div>急ブレーキ: {aiFeatures.hardBrakeCount}回</div>
                  <div>急ハンドル: {aiFeatures.sharpSteeringCount}回</div>
                  <div>カックン停止: {aiFeatures.lateBrakeReleaseCount}回</div>
                  <div>定速旋回: {aiFeatures.steadyCorneringTime.toFixed(1)}秒</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {lapResults.length > 0 && (
          <div className="w-full bg-gray-900 rounded-2xl p-4 border border-gray-800 mb-6">
            <h4 className="font-bold text-white mb-3 flex justify-between items-center">
              <span>ラップ別データ</span>
              <span className="text-xs font-normal text-gray-400">BESTラップをタップで比較</span>
            </h4>
            <div className="overflow-hidden rounded-xl border border-gray-800">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-950 text-gray-400 text-xs">
                  <tr>
                    <th className="px-3 py-2 font-medium">Lap</th>
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Max G</th>
                    <th className="px-3 py-2 font-medium text-right">Score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {lapResults.map(r => (
                    <tr 
                      key={r.index} 
                      onClick={() => setSelectedLapIndex(r.index)}
                      className={`cursor-pointer transition-colors ${selectedLapIndex === r.index ? 'bg-gray-800' : 'bg-gray-900/50 hover:bg-gray-800/50'}`}
                    >
                      <td className="px-3 py-2 font-mono text-gray-300">
                        {r.index}
                        {bestLapTime === r.time && <span className="ml-1 text-[10px] bg-pink-600 text-white px-1.5 py-0.5 rounded-full font-bold">BEST</span>}
                      </td>
                      <td className={`px-3 py-2 font-mono ${bestLapTime === r.time ? 'text-pink-400 font-bold' : 'text-gray-300'}`}>{formatTime(r.time)}</td>
                      <td className="px-3 py-2 font-mono text-gray-400">{r.maxG.toFixed(2)}</td>
                      <td className="px-3 py-2 font-mono text-right text-gray-300">
                        {r.score === -1 ? "-" : r.score}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="w-full mb-6">
          <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
            <h4 className="font-bold text-white mb-4 text-center">GGダイアグラム (分析)</h4>
            
            {/* Lap Selector */}
            {lapResults.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-2 mb-4">
                <button
                  onClick={() => setSelectedLapIndex('ALL')}
                  className={`px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap ${selectedLapIndex === 'ALL' ? 'bg-pink-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                >
                  ALL LAPS
                </button>
                {lapResults.map(r => (
                  <button
                    key={r.index}
                    onClick={() => setSelectedLapIndex(r.index)}
                    className={`px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap ${selectedLapIndex === r.index ? 'bg-pink-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                  >
                    Lap {r.index}
                  </button>
                ))}
              </div>
            )}
            
            <ResultGGDiagram data={selectedLapIndex === 'ALL' ? historyRef.current : lapResults.find(r => r.index === selectedLapIndex)?.data || []} />
          </div>
        </div>

        {/* Branding Footer for Screenshot */}
        <div className="w-full bg-gradient-to-r from-gray-900 via-gray-800 to-gray-900 rounded-2xl p-4 border border-gray-700/50 mt-2 flex flex-col items-center justify-center text-center shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-pink-500 to-transparent opacity-70"></div>
          <h4 className="text-white font-black tracking-widest text-lg mb-1 drop-shadow-md">
            Produced by <span className="text-pink-500">CRUISE</span> (クルーズ)
          </h4>
          <p className="text-xs text-gray-300 font-bold tracking-wider">
            サスペンション・アライメント・チューニング相談受付中
          </p>
        </div>

        </div>

        <div className="flex flex-col gap-3 mb-6">
          <button 
            onClick={() => {
              const traceRate = aiFeatures?.smoothRatio ? Math.round(aiFeatures.smoothRatio * 100) : 0;
              const maxGVal = aiFeatures?.maxG ? aiFeatures.maxG.toFixed(2) : "0.00";
              const url = "https://driving-analyzer.vercel.app";
              let text = "";
              if (mode === "Street") {
                text = `今日の運転スムーズスコアは【${jerkScore}点】！\n同乗者もタイヤも喜ぶ丁寧な荷重移動ができているか、チューニングショップ『クルーズ』のG診断アプリでチェックしました🏎️💨\n\nあなたの運転は何点？無料診断はこちら👇\n${url}\n\n#クルーズ #CRUISE #GSmooth #丁寧な運転 #足回り点検 #安全運転`;
              } else {
                text = `サーキット走行の荷重移動を診断！\n本日の最大G: 【${maxGVal}G】 / 摩擦円トレース率: 【${traceRate}%】🔥\nチューニングショップ『クルーズ』のテレメトリー診断で走りを分析中！\n\n${url}\n\n#クルーズ #CRUISE #サーキット走行 #アライメント調整 #十勝スピードウェイ #GSmooth`;
              }
              window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
            }}
            className="w-full bg-[#000000] border border-gray-700 hover:bg-gray-800 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors shadow-lg text-white"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="w-5 h-5 fill-current"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.005 3.869H5.078z"></path></svg>
            Xで結果をシェア
          </button>
          
          <button 
            onClick={async () => {
              const element = document.getElementById('result-capture-area');
              if (!element) return;
              try {
                const canvas = await html2canvas(element, { backgroundColor: '#000000', scale: 2 });
                const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
                const a = document.createElement('a');
                a.href = dataUrl;
                a.download = `G-Smooth_Result_${new Date().getTime()}.jpg`;
                a.click();
              } catch (e) {
                console.error('Image generation failed', e);
                alert('画像の生成に失敗しました');
              }
            }}
            className="w-full bg-pink-600 hover:bg-pink-700 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors shadow-lg text-white"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            カルテ画像を保存
          </button>
        </div>

        <button 
          onClick={() => setViewState("setup")}
          className="w-full bg-gray-800 hover:bg-gray-700 py-4 rounded-xl font-bold transition-colors shadow-lg text-white"
        >
          ホームへ戻る
        </button>
      </div>
    );
  }

  return null;
}
