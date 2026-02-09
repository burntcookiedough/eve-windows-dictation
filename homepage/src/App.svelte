<script lang="ts">
  let scrollY = $state(0);
  let currentSection = $state(0);
  let totalSections = 6;

  const murmurTexture = Array(250).fill('MURMUR').join(' ');

  const noiseUrl = `url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

  function getSectionCounterColor(section: number): string {
    if (section === 2) return 'text-[#3E0D0D]/40';
    return 'text-[#F0E6D0]/40';
  }

  $effect(() => {
    const onScroll = () => {
      scrollY = window.scrollY;
      const vh = window.innerHeight;
      currentSection = Math.min(Math.floor(scrollY / vh), totalSections - 1);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  });
</script>

<div>

  <!-- Scroll progress indicator — fixed left edge -->
  <div class="fixed left-0 top-0 bottom-0 w-1 z-50 bg-[#F0E6D0]/5">
    <div
      class="w-full bg-[#F0E6D0] transition-none"
      style="height: {Math.min(100, (scrollY / (window.innerHeight * (totalSections - 1))) * 100)}%"
    ></div>
  </div>

  <!-- Section counter — fixed bottom-right -->
  <div class="fixed bottom-6 right-6 z-50 font-mono text-xs tracking-widest select-none">
    <span class="{getSectionCounterColor(currentSection)} transition-colors duration-500">
      {String(currentSection + 1).padStart(2, '0')}/{String(totalSections).padStart(2, '0')}
    </span>
  </div>


  <!-- POSTER 1: MURMUR — Black bg, icon hero -->
  <section class="min-h-screen bg-[#0A0A0A] text-[#F0E6D0] relative overflow-hidden flex flex-col items-center justify-center">
    <div class="absolute inset-0 opacity-[0.06] pointer-events-none select-none mix-blend-overlay" aria-hidden="true" style="background-image: {noiseUrl};"></div>
    <div class="absolute inset-0 text-[6px] leading-[8px] text-[#F0E6D0]/[0.03] break-all font-mono select-none pointer-events-none p-2 overflow-hidden" aria-hidden="true">
      {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture}
    </div>

    <div class="relative z-10 text-center px-4">
      <img src="/icon.png" alt="Murmur" class="w-28 h-28 sm:w-36 sm:h-36 rounded-3xl mb-8 drop-shadow-2xl mx-auto" />
      <h1 class="text-[18vw] sm:text-[16vw] md:text-[15vw] font-black leading-[0.85] tracking-[-0.04em] uppercase select-none">
        MURMUR
      </h1>
      <div class="mt-4 sm:mt-6">
        <p class="text-sm tracking-[0.5em] uppercase text-[#F0E6D0]/50 font-mono">
          voice &rarr; text
        </p>
      </div>
      <div class="mt-16 sm:mt-20">
        <p class="text-xs tracking-[0.3em] uppercase text-[#F0E6D0]/20 font-mono">
          Desktop dictation for Windows &mdash; 100% local &mdash; MIT license
        </p>
      </div>
    </div>

    <div class="absolute bottom-8 left-1/2 -translate-x-1/2 text-[#F0E6D0]/20 text-xs tracking-[0.4em] uppercase font-mono select-none">
      scroll
    </div>
  </section>


  <!-- POSTER 2: SPEAK — Bright red bg -->
  <section class="min-h-screen bg-[#BF1D1D] text-[#F0E6D0] relative overflow-hidden flex flex-col justify-center">
    <div class="absolute inset-0 opacity-[0.06] pointer-events-none select-none mix-blend-overlay" aria-hidden="true" style="background-image: {noiseUrl};"></div>
    <div class="absolute inset-0 text-[6px] leading-[8px] text-[#F0E6D0]/[0.03] break-all font-mono select-none pointer-events-none p-2 overflow-hidden" aria-hidden="true">
      {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')} {Array(300).fill('SPEAK').join(' ')}
    </div>

    <div class="relative z-10 px-6 sm:px-12 md:px-20">
      <p class="text-[11vw] sm:text-[10vw] md:text-[9vw] font-black leading-[0.85] tracking-[-0.03em] uppercase rotate-[-2deg] origin-left select-none">
        PRESS.<br/>SPEAK.<br/>RELEASE.
      </p>

      <div class="mt-12 sm:mt-16 max-w-md rotate-[-2deg] origin-left">
        <p class="text-xs sm:text-sm tracking-[0.15em] uppercase text-[#F0E6D0]/70 font-mono leading-relaxed">
          Hold your hotkey.<br/>
          Speak naturally into your mic.<br/>
          Release the key.<br/>
          Your words appear where your cursor is.
        </p>
        <div class="mt-6 w-16 h-[1px] bg-[#F0E6D0]/30"></div>
        <p class="mt-4 text-xs tracking-[0.2em] uppercase text-[#F0E6D0]/40 font-mono">
          Real-time partial transcription overlay while you speak
        </p>
      </div>
    </div>
  </section>


  <!-- POSTER 3: LOCAL — Cream bg, dark text -->
  <section class="min-h-screen bg-[#F0E6D0] text-[#3E0D0D] relative overflow-hidden flex flex-col items-center justify-center">
    <div class="absolute inset-0 opacity-[0.06] pointer-events-none select-none mix-blend-multiply" aria-hidden="true" style="background-image: {noiseUrl};"></div>
    <div class="absolute inset-0 text-[5px] leading-[7px] text-[#3E0D0D]/[0.03] break-all font-mono select-none pointer-events-none p-2 overflow-hidden" aria-hidden="true">
      {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')} {Array(400).fill('LOCAL').join(' ')}
    </div>

    <div class="relative z-10 text-center px-6">
      <p class="text-xs tracking-[0.6em] uppercase text-[#3E0D0D]/30 font-mono mb-4">
        Nothing leaves your machine
      </p>

      <h2 class="text-[15vw] sm:text-[13vw] md:text-[12vw] font-black leading-[0.85] tracking-[-0.04em] uppercase select-none">
        100%<br/>LOCAL
      </h2>

      <div class="mt-10 sm:mt-14 max-w-sm mx-auto">
        <p class="text-xs sm:text-sm tracking-[0.15em] uppercase text-[#3E0D0D]/40 font-mono leading-loose">
          Powered by faster-whisper &mdash; runs entirely on your hardware.
          No cloud. No API calls. No data collection. No internet required.
          Your voice never leaves your computer.
        </p>
      </div>

      <div class="mt-12 inline-block border-4 border-[#3E0D0D] px-6 py-3 rotate-[-3deg]">
        <p class="text-sm sm:text-base font-black tracking-[0.3em] uppercase">
          Zero telemetry
        </p>
      </div>
    </div>
  </section>


  <!-- POSTER 4: FEATURES — Black bg, grid -->
  <section class="min-h-screen bg-[#0A0A0A] text-[#F0E6D0] relative overflow-hidden flex flex-col justify-center">
    <div class="absolute inset-0 opacity-[0.06] pointer-events-none select-none mix-blend-overlay" aria-hidden="true" style="background-image: {noiseUrl};"></div>
    <div class="absolute inset-0 text-[5px] leading-[7px] text-[#F0E6D0]/[0.03] break-all font-mono select-none pointer-events-none p-2 overflow-hidden" aria-hidden="true">
      {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture}
    </div>

    <div class="relative z-10 px-6 sm:px-12 md:px-20">
      <h2 class="text-[12vw] sm:text-[10vw] md:text-[8vw] font-black leading-[0.85] tracking-[-0.03em] uppercase mb-12 sm:mb-16 select-none">
        FEATURES
      </h2>

      <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-6 sm:gap-y-8 max-w-3xl">
        {#each [
          ['HOLD-TO-TALK', 'Push hotkey to record'],
          ['LIVE OVERLAY', 'See words as you speak'],
          ['AUTO-PASTE', 'Text appears at cursor'],
          ['WHISPER AI', 'OpenAI Whisper, locally'],
          ['SEARCHABLE', 'Full history with search'],
          ['CONFIDENCE', 'Per-word quality scores'],
          ['GPU ACCEL', 'CUDA-accelerated inference'],
          ['SYSTEM TRAY', 'Runs quietly in background'],
          ['OPEN SOURCE', 'MIT licensed, fully free'],
        ] as [title, desc]}
          <div class="group">
            <p class="text-sm sm:text-base font-black tracking-[0.15em] uppercase text-[#F0E6D0]/90">
              {title}
            </p>
            <p class="text-xs sm:text-sm tracking-[0.1em] uppercase text-[#F0E6D0]/30 font-mono mt-1">
              {desc}
            </p>
          </div>
        {/each}
      </div>
    </div>

    <div class="absolute top-6 right-6 text-[#F0E6D0]/10 text-[10px] font-mono select-none" aria-hidden="true">+</div>
    <div class="absolute bottom-6 left-6 text-[#F0E6D0]/10 text-[10px] font-mono select-none" aria-hidden="true">+</div>
  </section>


  <!-- POSTER 5: $0 FOREVER — Bright red bg -->
  <section class="min-h-screen bg-[#BF1D1D] text-[#F0E6D0] relative overflow-hidden flex flex-col items-center justify-center">
    <div class="absolute inset-0 opacity-[0.06] pointer-events-none select-none mix-blend-overlay" aria-hidden="true" style="background-image: {noiseUrl};"></div>
    <div class="absolute inset-0 text-[6px] leading-[8px] text-[#F0E6D0]/[0.03] break-all font-mono select-none pointer-events-none p-2 overflow-hidden" aria-hidden="true">
      {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')} {Array(350).fill('FREE').join(' ')}
    </div>

    <div class="relative z-10 text-center px-6">
      <h2 class="text-[22vw] sm:text-[18vw] md:text-[15vw] font-black leading-[0.8] tracking-[-0.05em] select-none">
        $0
      </h2>
      <p class="text-[8vw] sm:text-[6vw] md:text-[5vw] font-black leading-[1] tracking-[-0.02em] uppercase mt-2 select-none">
        FOREVER
      </p>

      <div class="mt-10 sm:mt-14">
        <div class="inline-block border-2 border-[#F0E6D0]/40 px-5 py-2 rotate-[2deg]">
          <p class="text-sm tracking-[0.4em] uppercase font-mono text-[#F0E6D0]/80">
            MIT License
          </p>
        </div>
      </div>

      <div class="mt-8 max-w-xs mx-auto">
        <p class="text-xs tracking-[0.15em] uppercase text-[#F0E6D0]/40 font-mono leading-loose">
          No subscription. No trial. No freemium.
          No usage limits. No premium tier.
          Free and open source. Period.
        </p>
      </div>
    </div>
  </section>


  <!-- POSTER 6: GET IT — Black bg, download -->
  <section class="min-h-screen bg-[#0A0A0A] text-[#F0E6D0] relative overflow-hidden flex flex-col items-center justify-center">
    <div class="absolute inset-0 opacity-[0.06] pointer-events-none select-none mix-blend-overlay" aria-hidden="true" style="background-image: {noiseUrl};"></div>
    <div class="absolute inset-0 text-[6px] leading-[8px] text-[#F0E6D0]/[0.03] break-all font-mono select-none pointer-events-none p-2 overflow-hidden" aria-hidden="true">
      {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture} {murmurTexture}
    </div>

    <div class="relative z-10 text-center px-6">
      <h2 class="text-[14vw] sm:text-[12vw] md:text-[10vw] font-black leading-[0.85] tracking-[-0.04em] uppercase mb-10 sm:mb-14 select-none">
        GET IT
      </h2>

      <a
        href="https://github.com/moeenm/murmur/releases"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-block bg-[#F0E6D0] text-[#3E0D0D] px-10 sm:px-14 py-4 sm:py-5 font-black text-sm sm:text-base tracking-[0.3em] uppercase cursor-pointer hover:bg-[#0A0A0A] hover:text-[#F0E6D0] transition-colors duration-150 select-none"
      >
        Download for Windows
      </a>

      <div class="mt-6">
        <a
          href="https://github.com/moeenm/murmur"
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs sm:text-sm tracking-[0.3em] uppercase text-[#F0E6D0]/30 font-mono hover:text-[#F0E6D0]/60 transition-colors duration-150 cursor-pointer"
        >
          View source on GitHub
        </a>
      </div>
    </div>

    <div class="absolute bottom-8 left-0 right-0 text-center">
      <div class="flex flex-col items-center gap-2">
        <div class="w-12 h-[1px] bg-[#F0E6D0]/10"></div>
        <p class="text-xs tracking-[0.4em] uppercase text-[#F0E6D0]/15 font-mono">
          Murmur v0.1.0 &mdash; MIT &mdash; Made for Windows
        </p>
      </div>
    </div>
  </section>

</div>
