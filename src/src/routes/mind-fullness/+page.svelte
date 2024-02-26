<svelte:head>
	<title>Mindfull Breathing</title>
	<meta name="description" content="Mindfull Breathing" />
</svelte:head>

<script>
	import "../../app.css";
	$:time = 1; 
	$:color = 'black'; 
	$:breathIn = 4; 
	$:stopOne = 4; 
	$:breathOut = 8;
	$:stopTwo = 4;
	$:play = false;
	$:textSwitch = 'テキスト表示';
	$:textBreathIn = '吸';
	$:textStop = '止';
	$:textBreathOut = '吐';
	let text = '';
	let btnText = '開始';
	let div;
	let btn;
	let grid;

	function updateDiv(dispText,scale,transTime) {
	  text = dispText
	  div.style.transform = 'scale('+scale+')';
	  div.style.transition = 'transform ' + transTime + 's';
	}


	async function breeth() {
		const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	
		const updateAndDelay = async (text, scale, time) => {
			updateDiv(text, scale, time);
			await delay(time * 1000);
			if (!play) return true;
		};
	
		if (await updateAndDelay(textBreathIn, 2, breathIn)) return;
		if (await updateAndDelay(textStop, 2, stopOne)) return;
		if (await updateAndDelay(textBreathOut, 0.5, breathOut)) return;
		if (await updateAndDelay(textStop, 0.5, stopTwo)) return;
	}

	async function repeat() {
		play = true;
		const stat = new Date().getTime();
		while (play) {
			await breeth();
			const end=  new Date().getTime();
			if(((time * 60 * 1000) <= (end - stat) * 60 / 1000) || !play) {
				repeatStop();
				break;
			}
		}
	}

	function repeatStop() {
		play = false;
		updateDiv('',1,0);
	}

	function textOnOff() {
		textBreathIn = textBreathIn === '吸' ? '' : '吸';
		textStop = textStop === '止' ? '' : '止';
		textBreathOut = textBreathOut === '吐' ? '' : '吐';
		textSwitch = textSwitch === 'テキスト表示' ? 'テキスト非表示' : 'テキスト表示';
	}
</script>

{#if !play }
<h1>Mindfull Breathing</h1>
{/if}
<div class="flex items-center justify-center p-20 m-5">
	<div class="flex items-center justify-center w-40 h-40 rounded-full" style="background: {color};" bind:this={div}>
		{#if play }
			<h1 class="text-4xl text-white">{text}</h1>
		{/if}
	</div>
</div>
{#if !play }
	<div class="flex items-center justify-center">
		<button class="w-20 mt-2 text-2xl font-bold bg-green-300 rounded-2xl" on:click={repeat} bind:this={btn}>{btnText}</button>
	</div>
	<div class="grid grid-cols-3 text-center" bind:this={grid}>
		<div class="m-3">
			<div>
				<p>時間</p>
				<input class="w-10 text-center rounded-xl" type="number" min="1" max="90" bind:value={time}>分
			</div>
			<input class="w-20" type="range" min="1" max="90" bind:value={time}>
		</div>
		<div class="m-3">
			<p>色</p>
			<input type="color" min="1" max="30" bind:value={color}>
		</div>
		<div class="m-3">
			<div>
				<p>吸う</p>
				<input class="w-10 p-1 text-center rounded-xl" type="number" min="1" max="30" bind:value={breathIn}>秒
			</div>
			<input class="w-20" type="range" min="1" max="30" bind:value={breathIn}>
		</div>
		<div class="m-3">
			<div>
				<p>止める</p>
				<input class="w-10 p-1 text-center rounded-xl" type="number" min="0" max="30" bind:value={stopOne}>秒
			</div>
			<input class="w-20" type="range" bind:value={stopOne} min="0" max="30">
		</div>
		<div class="m-3">
			<div>
				<p>吐く</p>
				<input class="w-10 p-1 text-center rounded-xl" type="number" min="1" max="30" bind:value={breathOut}>秒
			</div>
			<input class="w-20" type="range" min="1" max="30" bind:value={breathOut}>
		</div>
		<div class="m-3 text-nowrap">
			<div>
				<p>止める</p>
				<input class="w-10 p-1 text-center rounded-xl" type="number" min="0" max="30" bind:value={stopTwo}>秒
			</div>
			<input class="w-20" type="range" min="0" max="30" bind:value={stopTwo}>
		</div>
	</div>
{/if}
	<div class="flex items-center justify-center">
		<button class="w-20 mt-2 text-2xl font-bold bg-blue-300 rounded-2xl" on:click={repeatStop}>stop</button>
	</div>
	<div class="flex items-center justify-center">
		<button class="w-24 mt-24 text-xs font-bold bg-blue-300 rounded-xl" on:click={textOnOff}>{textSwitch}</button>
	</div>
