<script>
	import "../../app.css";
	import { onMount, onDestroy } from 'svelte';

	// Time
	let playTime = 1;
	let infinite = false;
	$: playTimeToMin = playTime * 60 * 1000;
	let breathIn = 4;
	let stopOne = 4;
	let breathOut = 8;
	let stopTwo = 4;

	// Circle color
	let color = '#a78bfa'; // violet-400

	function complementColor(hex) {
		const m = /^#?([\da-f]{6})$/i.exec(hex);
		if (!m) return hex;
		const n = parseInt(m[1], 16);
		const r = 255 - ((n >> 16) & 0xff);
		const g = 255 - ((n >> 8) & 0xff);
		const b = 255 - (n & 0xff);
		return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
	}

	// 止のフェーズ中だけ補色に切り替え
	$: displayColor = text === textStop ? complementColor(color) : color;

	// Play state
	let play = false;

	// Text labels
	const textBreathIn = '吸';
	const textStop = '止';
	const textBreathOut = '吐';
	let textOnOff = true;
	let text = '';

	// Countdown / completion UI state
	let showComplete = false;
	let completeTimeout = null;

	// Wake Lock
	let wakeLock = null;

	// Settings persistence
	const SETTINGS_KEY = 'mindfullness:settings:v1';
	let settingsLoaded = false;

	// 統計 (継続記録)
	const STATS_KEY = 'mindfullness:stats:v1';
	let stats = { totalSeconds: 0, sessions: 0, streakDays: 0, lastDate: '', longestStreak: 0 };

	// セッション進捗 (リングプログレス用)
	let sessionStartMs = 0;
	let sessionElapsedMs = 0;
	let progressIntervalId = null;
	$: progressPct = playTimeToMin > 0 ? Math.min(100, (sessionElapsedMs / playTimeToMin) * 100) : 0;

	// 呼吸プリセット
	const presets = [
		{ id: '4-7-8', label: '4-7-8', breathIn: 4, stopOne: 7, breathOut: 8, stopTwo: 0 },
		{ id: 'box', label: 'ボックス', breathIn: 4, stopOne: 4, breathOut: 4, stopTwo: 4 },
		{ id: 'simple', label: 'シンプル', breathIn: 5, stopOne: 0, breathOut: 5, stopTwo: 0 }
	];
	$: activePresetId =
		presets.find(
			(p) =>
				p.breathIn === breathIn &&
				p.stopOne === stopOne &&
				p.breathOut === breathOut &&
				p.stopTwo === stopTwo
		)?.id ?? 'custom';

	function applyPreset(p) {
		breathIn = p.breathIn;
		stopOne = p.stopOne;
		breathOut = p.breathOut;
		stopTwo = p.stopTwo;
	}

	// Element refs
	let div;
	let pipHost;
	let pipSlot;
	let pipCanvas;  // Video PiP 用のオフスクリーン描画先
	let pipVideo;   // canvas.captureStream() を流す <video>

	// PiP state
	let pipSupported = false;
	let pipActive = false;          // UI 用（どちらのモードでも true）
	let pipMode = null;             // 'doc' | 'video'
	let pipWindow = null;
	let hasDocPip = false;
	let hasVideoPip = false;

	// 円のスケールアニメ状態（canvas に反映するため）
	let currentScale = 1;
	let currentPhase = null;        // { from, to, startMs, durationMs, text }
	let canvasIntervalId = null;

	// ---- Web Worker（バックグラウンドでも止まらないタイマー） ----
	let timerWorker = null;

	// ---- BGM (MP3 ファイル再生) ----
	import bgmSrc from '../../bgm/ikoliks_aj-meditation-music-322801.mp3';
	let bgmOn = false;
	let bgmVolume = 0.3;
	let bgmAudio = null;            // HTMLAudioElement

	onMount(() => {
		if (typeof window === 'undefined') return;
		hasDocPip = 'documentPictureInPicture' in window;
		hasVideoPip =
			'pictureInPictureEnabled' in document &&
			document.pictureInPictureEnabled === true;
		pipSupported = hasDocPip || hasVideoPip;

		// 設定を localStorage から復元
		try {
			const raw = localStorage.getItem(SETTINGS_KEY);
			if (raw) {
				const s = JSON.parse(raw);
				if (typeof s.playTime === 'number') playTime = s.playTime;
				if (typeof s.infinite === 'boolean') infinite = s.infinite;
				if (typeof s.breathIn === 'number') breathIn = s.breathIn;
				if (typeof s.stopOne === 'number') stopOne = s.stopOne;
				if (typeof s.breathOut === 'number') breathOut = s.breathOut;
				if (typeof s.stopTwo === 'number') stopTwo = s.stopTwo;
				if (typeof s.color === 'string') color = s.color;
				if (typeof s.bgmVolume === 'number') bgmVolume = s.bgmVolume;
				if (typeof s.textOnOff === 'boolean') textOnOff = s.textOnOff;
			}
		} catch {}
		settingsLoaded = true;

		loadStats();

		// バックグラウンド復帰時に Wake Lock を取り直す
		document.addEventListener('visibilitychange', onVisibilityChange);

		// インライン Worker（setTimeout を Worker 内で実行 → バックグラウンドでも発火する）
		const code = `
			const t = {};
			onmessage = e => {
				if (e.data.c === 's') {
					t[e.data.id] = setTimeout(() => { postMessage(e.data.id); delete t[e.data.id]; }, e.data.ms);
				} else {
					clearTimeout(t[e.data.id]); delete t[e.data.id];
				}
			};
		`;
		try {
			timerWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
		} catch { /* Worker が使えない環境は通常 setTimeout にフォールバック */ }
	});

	onDestroy(() => {
		if (pipWindow) { try { pipWindow.close(); } catch {} }
		if (canvasIntervalId) clearInterval(canvasIntervalId);
		if (pipMode === 'video') {
			try { document.exitPictureInPicture(); } catch {}
		}
		if (timerWorker) { timerWorker.terminate(); timerWorker = null; }
		if (completeTimeout) clearTimeout(completeTimeout);
		stopProgressLoop();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
		releaseWakeLock();
		stopBgm();
	});

	// 設定変更を localStorage に書き出す
	$: if (settingsLoaded && typeof window !== 'undefined') {
		try {
			localStorage.setItem(
				SETTINGS_KEY,
				JSON.stringify({ playTime, infinite, breathIn, stopOne, breathOut, stopTwo, color, bgmVolume, textOnOff })
			);
		} catch {}
	}

	// ---- Wake Lock (画面スリープ防止) ----
	async function acquireWakeLock() {
		if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
		try {
			wakeLock = await navigator.wakeLock.request('screen');
			wakeLock.addEventListener?.('release', () => { wakeLock = null; });
		} catch {}
	}
	function releaseWakeLock() {
		if (!wakeLock) return;
		try { wakeLock.release(); } catch {}
		wakeLock = null;
	}
	function onVisibilityChange() {
		if (document.visibilityState === 'visible' && play && !wakeLock) {
			acquireWakeLock();
		}
	}

	// ---- 終了チャイム (チーン: 鈴/ベル風) ----
	function playEndChime() {
		if (typeof window === 'undefined') return;
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return;
		try {
			const ctx = new AC();
			const tone = (freq, duration, peak) => {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = 'sine';
				osc.frequency.value = freq;
				osc.connect(gain);
				gain.connect(ctx.destination);
				const t0 = ctx.currentTime;
				gain.gain.setValueAtTime(0, t0);
				gain.gain.linearRampToValueAtTime(peak, t0 + 0.005); // 鋭いアタック
				gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration); // 長い減衰
				osc.start(t0);
				osc.stop(t0 + duration + 0.05);
			};
			// 基音 + わずかに不協和な倍音で金属的な「チーン」
			tone(1760, 3.8, 0.28);  // A6 基音
			tone(2637, 2.2, 0.10);  // 5 度倍音 (短めに減衰)
			tone(3520, 1.4, 0.06);  // オクターブ (キラッとした輝き)
			setTimeout(() => { try { ctx.close(); } catch {} }, 4500);
		} catch {}
	}

	function showCompletion() {
		showComplete = true;
		if (completeTimeout) clearTimeout(completeTimeout);
		completeTimeout = setTimeout(() => { showComplete = false; }, 4000);
	}

	// ---- 統計 (継続記録) ----
	function loadStats() {
		try {
			const raw = localStorage.getItem(STATS_KEY);
			if (raw) {
				const s = JSON.parse(raw);
				stats = { ...stats, ...s };
			}
		} catch {}
	}

	function todayStr() {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	function dayDiff(a, b) {
		const [y1, m1, d1] = a.split('-').map(Number);
		const [y2, m2, d2] = b.split('-').map(Number);
		const da = new Date(y1, m1 - 1, d1).getTime();
		const db = new Date(y2, m2 - 1, d2).getTime();
		return Math.round((db - da) / (24 * 60 * 60 * 1000));
	}

	function recordSession(elapsedSeconds) {
		if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 60) return;
		const today = todayStr();
		let newStreak = stats.streakDays || 0;
		if (!stats.lastDate) {
			newStreak = 1;
		} else if (stats.lastDate === today) {
			newStreak = Math.max(newStreak, 1);
		} else {
			const diff = dayDiff(stats.lastDate, today);
			newStreak = diff === 1 ? newStreak + 1 : 1;
		}
		stats = {
			totalSeconds: (stats.totalSeconds || 0) + Math.round(elapsedSeconds),
			sessions: (stats.sessions || 0) + 1,
			streakDays: newStreak,
			lastDate: today,
			longestStreak: Math.max(stats.longestStreak || 0, newStreak)
		};
		try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch {}
	}

	// ---- 進捗ループ ----
	function startProgressLoop() {
		if (progressIntervalId) return;
		progressIntervalId = setInterval(() => {
			sessionElapsedMs = Date.now() - sessionStartMs;
		}, 200);
	}
	function stopProgressLoop() {
		if (progressIntervalId) clearInterval(progressIntervalId);
		progressIntervalId = null;
	}

	/** バックグラウンドでも止まらない delay。Worker が使えない場合は通常の setTimeout */
	function delay(ms) {
		if (!timerWorker) return new Promise((r) => setTimeout(r, ms));
		return new Promise((resolve) => {
			const id = Math.random();
			const handler = (e) => {
				if (e.data === id) {
					timerWorker.removeEventListener('message', handler);
					resolve();
				}
			};
			timerWorker.addEventListener('message', handler);
			timerWorker.postMessage({ c: 's', id, ms });
		});
	}

	// ---- Canvas 描画 (Video PiP 用) ----
	function easeInOut(t) {
		return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
	}

	function computeScale() {
		if (!currentPhase) return currentScale;
		const elapsed = performance.now() - currentPhase.startMs;
		const t = Math.min(1, elapsed / Math.max(1, currentPhase.durationMs));
		const e = easeInOut(t);
		return currentPhase.from + (currentPhase.to - currentPhase.from) * e;
	}

	function drawCanvas() {
		if (!pipCanvas) return;
		const ctx = pipCanvas.getContext('2d');
		const w = pipCanvas.width;
		const h = pipCanvas.height;
		const scale = computeScale();
		const baseR = Math.min(w, h) * 0.2;
		const r = baseR * scale;
		const cx = w / 2;
		const cy = h / 2;

		// 背景グラデ
		const bg = ctx.createLinearGradient(0, 0, 0, h);
		bg.addColorStop(0, '#1e1b4b');
		bg.addColorStop(1, '#4c1d95');
		ctx.fillStyle = bg;
		ctx.fillRect(0, 0, w, h);

		// 円のグロー
		ctx.save();
		ctx.shadowColor = 'rgba(167,139,250,0.55)';
		ctx.shadowBlur = 40;
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fillStyle = displayColor;
		ctx.fill();
		ctx.restore();

		// テキスト
		const txt = currentPhase?.text ?? '';
		if (textOnOff && txt) {
			ctx.fillStyle = 'white';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.font = `600 ${Math.max(14, Math.floor(r * 0.55))}px Arial, sans-serif`;
			ctx.fillText(txt, cx, cy);
		}
	}

	/** setInterval ベース（RAF はバックグラウンドで完全停止するため） */
	function startCanvasLoop() {
		if (canvasIntervalId) return;
		canvasIntervalId = setInterval(drawCanvas, 33); // ~30fps
	}
	function stopCanvasLoop() {
		if (canvasIntervalId) clearInterval(canvasIntervalId);
		canvasIntervalId = null;
	}

	function copyStyles(target) {
		for (const sheet of document.styleSheets) {
			try {
				const rules = sheet.cssRules;
				const style = document.createElement('style');
				style.textContent = Array.from(rules).map((r) => r.cssText).join('\n');
				target.head.appendChild(style);
			} catch {
				if (sheet.href) {
					const link = document.createElement('link');
					link.rel = 'stylesheet';
					link.href = sheet.href;
					target.head.appendChild(link);
				}
			}
		}
	}

	async function togglePip() {
		if (!pipSupported) return;
		// すでに PiP 中 → 閉じる
		if (pipMode === 'doc') { pipWindow?.close(); return; }
		if (pipMode === 'video') {
			try { await document.exitPictureInPicture(); } catch {}
			return;
		}
		// 未起動 → 対応モードで開く（Document 優先、なければ Video PiP）
		if (hasDocPip) {
			await openDocPip();
		} else if (hasVideoPip) {
			await openVideoPip();
		}
	}

	async function openDocPip() {
		pipWindow = await window.documentPictureInPicture.requestWindow({ width: 300, height: 360 });
		copyStyles(pipWindow.document);
		const html = pipWindow.document.documentElement;
		html.style.background = 'linear-gradient(180deg, #1e1b4b 0%, #4c1d95 100%)';
		const body = pipWindow.document.body;
		body.style.margin = '0';
		body.style.minHeight = '100vh';
		body.style.color = 'white';
		body.style.fontFamily = 'Arial, sans-serif';
		body.style.display = 'flex';
		body.style.flexDirection = 'column';
		body.style.alignItems = 'center';
		body.style.justifyContent = 'center';
		body.style.overflow = 'hidden';
		body.appendChild(pipHost);
		pipMode = 'doc';
		pipActive = true;
		pipWindow.addEventListener('pagehide', () => {
			if (pipHost && pipSlot) pipSlot.appendChild(pipHost);
			pipActive = false;
			pipMode = null;
			pipWindow = null;
		});
	}

	async function openVideoPip() {
		// canvas を描画開始 → captureStream → video に流す → PiP 要求
		startCanvasLoop();
		if (!pipVideo.srcObject) {
			const stream = pipCanvas.captureStream(30);
			pipVideo.srcObject = stream;
		}
		try {
			await pipVideo.play();
		} catch {}
		await pipVideo.requestPictureInPicture();
		pipMode = 'video';
		pipActive = true;
		const onLeave = () => {
			pipVideo.removeEventListener('leavepictureinpicture', onLeave);
			stopCanvasLoop();
			try { pipVideo.pause(); } catch {}
			pipActive = false;
			pipMode = null;
		};
		pipVideo.addEventListener('leavepictureinpicture', onLeave);
	}

	function updateDiv(dispText, scale, transTime) {
		text = dispText;
		div.style.transform = 'scale(' + scale + ')';
		div.style.transition = 'transform ' + transTime + 's ease-in-out';
		// canvas 側の位相情報を更新（Video PiP 中でも連動させるため）
		currentPhase = {
			from: currentScale,
			to: scale,
			startMs: performance.now(),
			durationMs: Math.max(1, transTime * 1000),
			text: dispText
		};
		currentScale = scale;
	}

	async function breeth() {
		const updateAndDelay = async (t, scale, time) => {
			updateDiv(t, scale, time);
			await delay(time * 1000);
			if (!play) return true;
		};
		if (await updateAndDelay(textBreathIn, 2, breathIn)) return;
		if (await updateAndDelay(textStop, 2, stopOne)) return;
		if (await updateAndDelay(textBreathOut, 0.5, breathOut)) return;
		if (await updateAndDelay(textStop, 0.5, stopTwo)) return;
	}

	async function runCountdown() {
		for (let i = 3; i >= 1; i--) {
			if (!play) return false;
			updateDiv(String(i), 1.2, 0.3);
			await delay(1000);
		}
		return play;
	}

	async function repeat() {
		play = true;
		showComplete = false;
		acquireWakeLock();

		const ok = await runCountdown();
		if (!ok) { updateDiv('', 1, 0); return; }

		sessionStartMs = Date.now();
		sessionElapsedMs = 0;
		startProgressLoop();

		while (play) {
			await breeth();
			if (!play) break;
			if (infinite) continue;
			if (playTimeToMin <= Date.now() - sessionStartMs) {
				finishNaturally();
				break;
			}
		}
	}

	function finishNaturally() {
		const elapsed = sessionStartMs ? (Date.now() - sessionStartMs) / 1000 : 0;
		play = false;
		updateDiv('', 1, 0);
		releaseWakeLock();
		stopProgressLoop();
		playEndChime();
		showCompletion();
		recordSession(elapsed);
	}

	function repeatStop() {
		const elapsed = sessionStartMs ? (Date.now() - sessionStartMs) / 1000 : 0;
		play = false;
		updateDiv('', 1, 0);
		releaseWakeLock();
		stopProgressLoop();
		recordSession(elapsed);
	}

	function togglePlay() {
		if (play) repeatStop();
		else repeat();
	}

	// ---- シェア ----
	let shareToast = '';
	let shareToastTimeout = null;
	async function share() {
		const url = typeof window !== 'undefined' ? window.location.href : '';
		const data = {
			title: 'Mindfull Breathing',
			text: 'ゆったり呼吸を整えよう',
			url
		};
		try {
			if (typeof navigator !== 'undefined' && navigator.share) {
				await navigator.share(data);
				return;
			}
			if (typeof navigator !== 'undefined' && navigator.clipboard) {
				await navigator.clipboard.writeText(url);
				flashShareToast('リンクをコピーしました');
				return;
			}
			flashShareToast(url);
		} catch (e) {
			if (e && e.name === 'AbortError') return;
			flashShareToast('シェアに失敗しました');
		}
	}
	function flashShareToast(msg) {
		shareToast = msg;
		if (shareToastTimeout) clearTimeout(shareToastTimeout);
		shareToastTimeout = setTimeout(() => { shareToast = ''; }, 2500);
	}

	function textToggle() {
		textOnOff = !textOnOff;
	}

	// ---- BGM ----
	function startBgm() {
		if (bgmAudio) return;
		bgmAudio = new Audio(bgmSrc);
		bgmAudio.loop = true;
		bgmAudio.volume = bgmVolume;
		bgmAudio.play().catch(() => {});
	}

	function stopBgm() {
		if (!bgmAudio) return;
		bgmAudio.pause();
		bgmAudio.currentTime = 0;
		bgmAudio = null;
	}

	function toggleBgm() {
		bgmOn = !bgmOn;
		if (bgmOn) startBgm();
		else stopBgm();
	}

	// ボリュームスライダー変更時に即時反映
	$: if (bgmAudio) {
		bgmAudio.volume = bgmVolume;
	}

	// レイアウト分岐用: Document PiP 中のみ pipHost が別ウィンドウへ移動するので、
	// コンパクトな 4 ボタン UI に切替える。Video PiP 中は本体 UI は通常のまま。
	$: docPipActive = pipMode === 'doc';
</script>

<svelte:head>
	<title>Mindfull Breathing</title>
	<meta name="description" content="Mindfull Breathing" />
	<style>
		/* このページだけ背景を差し替える */
		body {
			background: linear-gradient(180deg, #1e1b4b 0%, #4c1d95 100%) !important;
			background-attachment: fixed !important;
			color: white;
		}
	</style>
</svelte:head>

<!-- Video PiP 用のオフスクリーン要素（画面外に固定） -->
<div class="offscreen" aria-hidden="true">
	<canvas bind:this={pipCanvas} width="480" height="480"></canvas>
	<!-- svelte-ignore a11y-media-has-caption -->
	<video bind:this={pipVideo} muted playsinline></video>
</div>

<div class="page">
	{#if !docPipActive}
		<h1 class="page-title">Mindfull Breathing</h1>
		<p class="page-sub">ゆったり呼吸を整えよう</p>
		{#if stats.sessions > 0}
			<div class="stats-row" aria-label="継続記録">
				<div class="stat">
					<div class="stat-num">{stats.streakDays}</div>
					<div class="stat-lbl">連続日数</div>
				</div>
				<div class="stat">
					<div class="stat-num">{Math.round((stats.totalSeconds || 0) / 60)}</div>
					<div class="stat-lbl">累計分</div>
				</div>
				<div class="stat">
					<div class="stat-num">{stats.sessions}</div>
					<div class="stat-lbl">セッション</div>
				</div>
			</div>
		{/if}
	{/if}

	<div class="pip-slot" bind:this={pipSlot}>
		<div bind:this={pipHost} class:pip={docPipActive}>
			<!-- 円：stage で最大スケール分のスペースを確保 -->
			<div class="circle-stage {docPipActive ? 'stage-sm' : 'stage-lg'}">
				{#if play && !infinite}
					<svg class="progress-ring" viewBox="0 0 100 100" aria-hidden="true">
						<circle class="progress-track" cx="50" cy="50" r="48" pathLength="100" />
						<circle
							class="progress-fill"
							cx="50"
							cy="50"
							r="48"
							pathLength="100"
							stroke-dasharray="{progressPct} {100 - progressPct}"
							transform="rotate(-90 50 50)"
						/>
					</svg>
				{/if}
				<div
					class="circle {docPipActive ? 'circle-sm' : 'circle-lg'}"
					style="background: {displayColor};"
					bind:this={div}
				>
					{#if textOnOff}
						<span class="circle-text {docPipActive ? 'text-xl' : 'text-3xl'}">{text}</span>
					{/if}
				</div>
			</div>

			{#if docPipActive}
				<!-- Document PiP: 4 ボタンのみ -->
				<div class="pip-grid">
					<button class="btn btn-start" on:click={repeat} disabled={play}>開始</button>
					<button class="btn btn-stop" on:click={repeatStop} disabled={!play}>停止</button>
					<button class="btn btn-util" on:click={textToggle}>
						{textOnOff ? '文字ON' : '文字OFF'}
					</button>
					<button class="btn btn-pip" on:click={togglePip}>PiP終了</button>
				</div>
			{:else}
				<!-- 通常画面 -->
				<div class="primary-action">
					<button class="btn-primary {play ? 'is-stop' : 'is-start'}" on:click={togglePlay}>
						{play ? '停止' : '開始'}
					</button>
				</div>

				{#if !play}
					<div class="presets">
						<span class="presets-label">プリセット</span>
						<div class="preset-chips">
							{#each presets as p}
								<button
									type="button"
									class="preset-chip {activePresetId === p.id ? 'is-active' : ''}"
									on:click={() => applyPreset(p)}
								>
									{p.label}
									<span class="preset-detail">{p.breathIn}-{p.stopOne}-{p.breathOut}-{p.stopTwo}</span>
								</button>
							{/each}
							{#if activePresetId === 'custom'}
								<span class="preset-chip is-custom">カスタム</span>
							{/if}
						</div>
					</div>
					<div class="settings">
						<div class="setting-item">
							<div class="setting-label">
								<span>時間</span>
								<span class="setting-value">{infinite ? '無制限' : `${playTime} 分`}</span>
							</div>
							<input type="range" min="1" max="180" bind:value={playTime} disabled={infinite} />
							<button
								class="infinite-toggle {infinite ? 'is-on' : ''}"
								on:click={() => (infinite = !infinite)}
								aria-pressed={infinite}
								type="button"
							>
								∞ 無制限
							</button>
						</div>

						<div class="setting-item">
							<div class="setting-label">
								<span>円の色</span>
								<span class="color-dot" style="background:{color}"></span>
							</div>
							<input type="color" bind:value={color} class="color-input" />
						</div>

						<div class="setting-item span-2">
							<div class="setting-label">
								<span>BGM 音量</span>
								<span class="setting-value">{Math.round(bgmVolume * 100)} %</span>
							</div>
							<input type="range" min="0" max="1" step="0.01" bind:value={bgmVolume} />
						</div>

						<div class="setting-item">
							<div class="setting-label">
								<span>吸う</span>
								<span class="setting-value">{breathIn} 秒</span>
							</div>
							<input type="range" min="1" max="30" bind:value={breathIn} />
						</div>

						<div class="setting-item">
							<div class="setting-label">
								<span>止める 1</span>
								<span class="setting-value">{stopOne} 秒</span>
							</div>
							<input type="range" min="0" max="30" bind:value={stopOne} />
						</div>

						<div class="setting-item">
							<div class="setting-label">
								<span>吐く</span>
								<span class="setting-value">{breathOut} 秒</span>
							</div>
							<input type="range" min="1" max="30" bind:value={breathOut} />
						</div>

						<div class="setting-item">
							<div class="setting-label">
								<span>止める 2</span>
								<span class="setting-value">{stopTwo} 秒</span>
							</div>
							<input type="range" min="0" max="30" bind:value={stopTwo} />
						</div>
					</div>
				{/if}

				<div class="utility-row">
					<button class="util-btn" on:click={textToggle} aria-pressed={textOnOff}>
						<span class="dot {textOnOff ? 'on' : 'off'}"></span>
						{textOnOff ? '文字 ON' : '文字 OFF'}
					</button>
					<button class="util-btn" on:click={toggleBgm} aria-pressed={bgmOn}>
						<span class="dot {bgmOn ? 'on' : 'off'}"></span>
						{bgmOn ? 'BGM ON' : 'BGM OFF'}
					</button>
					{#if pipSupported}
						<button class="util-btn" on:click={togglePip}>
							{pipActive ? 'PiP終了' : 'PiP'}
						</button>
					{/if}
				</div>

				<div class="share-row">
					<button class="share-btn" on:click={share} aria-label="シェア">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="18" cy="5" r="3"></circle>
							<circle cx="6" cy="12" r="3"></circle>
							<circle cx="18" cy="19" r="3"></circle>
							<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
							<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
						</svg>
						シェア
					</button>
					{#if shareToast}
						<span class="share-toast">{shareToast}</span>
					{/if}
				</div>
			{/if}

			{#if showComplete}
				<div class="complete-toast" role="status">
					<div class="complete-title">お疲れさまでした</div>
					<div class="complete-sub">{playTime} 分の瞑想を完了しました</div>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.offscreen {
		position: fixed;
		left: -10000px;
		top: -10000px;
		width: 0;
		height: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.page {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 1.5rem 1rem 3rem;
		color: #fff;
	}

	.page-title {
		font-size: 1.75rem;
		font-weight: 300;
		letter-spacing: 0.08em;
		margin: 0.5rem 0 0.25rem;
		text-align: center;
		color: #ede9fe;
	}

	.page-sub {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
		color: rgba(237, 233, 254, 0.7);
		letter-spacing: 0.05em;
	}

	.pip-slot {
		width: 100%;
		display: flex;
		justify-content: center;
	}

	/* PiP 中は pipHost が body 直下に置かれるので、そのレイアウトを整える */
	.pip {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		padding: 0.5rem 0.75rem 0.75rem;
		box-sizing: border-box;
	}

	/* 円 stage: 最大スケール(2x)のぶんの領域を予約してレイアウト崩れを防ぐ */
	.circle-stage {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.stage-lg {
		width: 15rem;
		height: 15rem;
		margin: 1.25rem 0 1.25rem;
	}
	.stage-sm {
		width: 9rem;
		height: 9rem;
		margin: 0.5rem 0 0.5rem;
	}
	.circle {
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
		box-shadow:
			0 0 60px rgba(167, 139, 250, 0.45),
			0 0 120px rgba(139, 92, 246, 0.25),
			inset 0 0 30px rgba(255, 255, 255, 0.08);
		transition: transform 0.3s ease-in-out;
	}
	.circle-lg {
		width: 7.5rem;
		height: 7.5rem;
	}
	.circle-sm {
		width: 4.5rem;
		height: 4.5rem;
	}
	.circle-text {
		color: white;
		font-weight: 500;
		letter-spacing: 0.05em;
		user-select: none;
	}
	.text-3xl {
		font-size: 2rem;
	}
	.text-xl {
		font-size: 1.25rem;
	}

	/* メインの開始/停止ボタン */
	.primary-action {
		margin-top: 0.5rem;
	}
	.btn-primary {
		min-width: 10rem;
		padding: 0.85rem 2rem;
		font-size: 1.1rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		border-radius: 9999px;
		border: 1px solid rgba(255, 255, 255, 0.2);
		color: white;
		cursor: pointer;
		transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease;
	}
	.btn-primary:hover {
		transform: translateY(-1px);
	}
	.btn-primary:active {
		transform: translateY(0);
	}
	.is-start {
		background: linear-gradient(135deg, #10b981 0%, #059669 100%);
		box-shadow: 0 8px 24px rgba(16, 185, 129, 0.35);
	}
	.is-stop {
		background: linear-gradient(135deg, #f43f5e 0%, #e11d48 100%);
		box-shadow: 0 8px 24px rgba(244, 63, 94, 0.35);
	}

	/* 設定パネル */
	.settings {
		width: 100%;
		max-width: 28rem;
		margin-top: 1.5rem;
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.75rem;
		padding: 1rem;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 1rem;
		backdrop-filter: blur(8px);
	}
	.setting-item {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.5rem;
	}
	.setting-item.span-2 {
		grid-column: 1 / -1;
	}
	.setting-label {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.75rem;
		color: rgba(237, 233, 254, 0.8);
		letter-spacing: 0.05em;
	}
	.setting-value {
		font-size: 0.8rem;
		color: #c4b5fd;
		font-variant-numeric: tabular-nums;
	}
	.color-dot {
		display: inline-block;
		width: 0.9rem;
		height: 0.9rem;
		border-radius: 9999px;
		border: 1px solid rgba(255, 255, 255, 0.3);
	}
	.color-input {
		appearance: none;
		-webkit-appearance: none;
		width: 100%;
		height: 2rem;
		border: none;
		background: transparent;
		cursor: pointer;
		padding: 0;
	}
	.color-input::-webkit-color-swatch-wrapper {
		padding: 0;
	}
	.color-input::-webkit-color-swatch {
		border-radius: 0.5rem;
		border: 1px solid rgba(255, 255, 255, 0.2);
	}

	/* range スタイル */
	.setting-item input[type='range'] {
		-webkit-appearance: none;
		appearance: none;
		width: 100%;
		height: 0.35rem;
		background: rgba(255, 255, 255, 0.15);
		border-radius: 9999px;
		outline: none;
	}
	.setting-item input[type='range']::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		background: #c4b5fd;
		cursor: pointer;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
		border: 2px solid #ede9fe;
	}
	.setting-item input[type='range']::-moz-range-thumb {
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		background: #c4b5fd;
		cursor: pointer;
		border: 2px solid #ede9fe;
	}
	.setting-item input[type='range']:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.infinite-toggle {
		margin-top: 0.4rem;
		align-self: flex-start;
		padding: 0.25rem 0.7rem;
		font-size: 0.7rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		color: rgba(237, 233, 254, 0.85);
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 9999px;
		cursor: pointer;
		transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
	}
	.infinite-toggle:hover {
		background: rgba(255, 255, 255, 0.12);
		border-color: rgba(255, 255, 255, 0.3);
	}
	.infinite-toggle.is-on {
		background: linear-gradient(135deg, rgba(167, 139, 250, 0.6), rgba(139, 92, 246, 0.6));
		border-color: rgba(196, 181, 253, 0.7);
		color: #fff;
	}

	/* 下段ユーティリティ行 */
	.utility-row {
		display: flex;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}
	.util-btn {
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		color: rgba(237, 233, 254, 0.9);
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 9999px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		transition: background 0.2s ease, border-color 0.2s ease;
	}
	.util-btn:hover {
		background: rgba(255, 255, 255, 0.14);
		border-color: rgba(255, 255, 255, 0.3);
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 9999px;
		display: inline-block;
	}
	.dot.on {
		background: #86efac;
		box-shadow: 0 0 8px rgba(134, 239, 172, 0.6);
	}
	.dot.off {
		background: rgba(255, 255, 255, 0.3);
	}

	/* PiP 内部レイアウト */
	.pip-grid {
		width: 100%;
		max-width: 240px;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem;
		margin-top: 0.25rem;
	}
	.btn {
		padding: 0.5rem 0;
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		border-radius: 9999px;
		border: 1px solid rgba(255, 255, 255, 0.15);
		color: white;
		cursor: pointer;
		transition: transform 0.1s ease, filter 0.15s ease;
	}
	.btn:hover:not(:disabled) {
		filter: brightness(1.1);
	}
	.btn:active:not(:disabled) {
		transform: translateY(1px);
	}
	.btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}
	.btn-start {
		background: linear-gradient(135deg, #10b981, #059669);
	}
	.btn-stop {
		background: linear-gradient(135deg, #f43f5e, #e11d48);
	}
	.btn-util {
		background: rgba(255, 255, 255, 0.12);
	}
	.btn-pip {
		background: linear-gradient(135deg, #8b5cf6, #6d28d9);
	}

	/* シェア */
	.share-row {
		margin-top: 1.25rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}
	.share-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.55rem 1.25rem;
		font-size: 0.85rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		color: #ede9fe;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 9999px;
		cursor: pointer;
		transition: background 0.2s ease, border-color 0.2s ease, transform 0.1s ease;
	}
	.share-btn:hover {
		background: rgba(255, 255, 255, 0.14);
		border-color: rgba(255, 255, 255, 0.3);
	}
	.share-btn:active {
		transform: translateY(1px);
	}
	.share-toast {
		font-size: 0.75rem;
		color: #c4b5fd;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
		padding: 0.3rem 0.7rem;
		border-radius: 9999px;
	}

	/* 完了トースト */
	.complete-toast {
		margin-top: 1.5rem;
		padding: 1rem 1.5rem;
		text-align: center;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(196, 181, 253, 0.4);
		border-radius: 1rem;
		backdrop-filter: blur(8px);
		animation: fadeIn 0.4s ease;
	}
	.complete-title {
		font-size: 1.1rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		color: #ede9fe;
	}
	.complete-sub {
		margin-top: 0.25rem;
		font-size: 0.8rem;
		color: rgba(237, 233, 254, 0.7);
	}
	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(6px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* 統計バッジ */
	.stats-row {
		display: flex;
		gap: 1.25rem;
		margin: 0.5rem 0 0;
		padding: 0.4rem 0.9rem;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 9999px;
	}
	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		min-width: 3rem;
	}
	.stat-num {
		font-size: 1.05rem;
		font-weight: 600;
		color: #ede9fe;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.stat-lbl {
		font-size: 0.65rem;
		color: rgba(237, 233, 254, 0.65);
		letter-spacing: 0.05em;
		margin-top: 0.1rem;
	}

	/* プリセット */
	.presets {
		width: 100%;
		max-width: 28rem;
		margin-top: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.presets-label {
		font-size: 0.7rem;
		color: rgba(237, 233, 254, 0.6);
		letter-spacing: 0.08em;
		padding-left: 0.25rem;
	}
	.preset-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.preset-chip {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.35rem 0.75rem;
		font-size: 0.78rem;
		font-weight: 500;
		letter-spacing: 0.04em;
		color: rgba(237, 233, 254, 0.85);
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 9999px;
		cursor: pointer;
		transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
	}
	.preset-chip:hover {
		background: rgba(255, 255, 255, 0.12);
	}
	.preset-chip.is-active {
		background: linear-gradient(135deg, rgba(167, 139, 250, 0.55), rgba(139, 92, 246, 0.55));
		border-color: rgba(196, 181, 253, 0.7);
		color: #fff;
	}
	.preset-chip.is-custom {
		font-style: italic;
		color: rgba(237, 233, 254, 0.55);
		cursor: default;
	}
	.preset-detail {
		font-size: 0.65rem;
		color: rgba(237, 233, 254, 0.55);
		font-variant-numeric: tabular-nums;
	}
	.preset-chip.is-active .preset-detail {
		color: rgba(255, 255, 255, 0.75);
	}

	/* リングプログレス */
	.progress-ring {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	.progress-track {
		fill: none;
		stroke: rgba(255, 255, 255, 0.08);
		stroke-width: 1.2;
	}
	.progress-fill {
		fill: none;
		stroke: rgba(196, 181, 253, 0.8);
		stroke-width: 1.5;
		stroke-linecap: round;
		filter: drop-shadow(0 0 3px rgba(196, 181, 253, 0.5));
		transition: stroke-dasharray 0.25s linear;
	}
</style>
