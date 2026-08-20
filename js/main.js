/**
 * CAPITAL CITY ROLEPLAY - CLIENT JAVASCRIPT
 * Ultra High-Performance Engine (GPU Parallax, Lightweight Reveal, Typewriter, FAQ & Mockup Carousel)
 */

document.addEventListener('DOMContentLoaded', () => {
  setupTypewriterAnimation();
  setupHeaderScroll();
  setupScrollReveal();
  setupPhoneCarousel();
  setupFaq();
  setupScrollEngine();
});

/* ==========================================================================
   1. ULTRA-FAST GPU SCROLL ENGINE (ZERO-PAINT PARALLAX)
   ========================================================================== */
function setupScrollEngine() {
  const progressBar = document.getElementById('scroll-progress');
  const heroBg = document.getElementById('hero-bg-parallax');
  const heroContent = document.getElementById('hero-content');

  // Parallax Background Layers
  const parallaxCity = document.getElementById('parallax-city');
  const parallaxGrid = document.getElementById('parallax-grid');
  const parallaxOrb1 = document.getElementById('parallax-orb-1');
  const parallaxOrb2 = document.getElementById('parallax-orb-2');
  const parallaxBeam = document.getElementById('parallax-beam');

  let ticking = false;

  const onScroll = () => {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  };

  const update = () => {
    const scrollY = window.scrollY;
    const vh = window.innerHeight;
    const docHeight = document.documentElement.scrollHeight - vh;
    const scrollRatio = docHeight > 0 ? scrollY / docHeight : 0;

    // 1. Neon Progress Bar (GPU Scale)
    if (progressBar) {
      progressBar.style.transform = `scaleX(${scrollRatio})`;
    }

    // 2. Hero Parallax (Only runs while hero is near viewport)
    if (scrollY < vh * 1.25) {
      if (heroBg) {
        heroBg.style.transform = `translate3d(0, ${(scrollY * 0.32).toFixed(1)}px, 0)`;
      }
      if (heroContent) {
        const opacityVal = Math.max(1 - scrollY / 600, 0);
        heroContent.style.transform = `translate3d(0, ${(scrollY * 0.14).toFixed(1)}px, 0)`;
        heroContent.style.opacity = opacityVal.toFixed(2);
      }
    }

    // 3. Post-Hero GPU Parallax (Pure 3D Hardware Accelerated Transforms)
    if (scrollY > 40) {
      if (parallaxCity) {
        parallaxCity.style.transform = `translate3d(0, ${((scrollRatio - 0.5) * -80).toFixed(1)}px, 0)`;
      }
      if (parallaxGrid) {
        parallaxGrid.style.transform = `translate3d(0, ${((scrollRatio - 0.5) * -120).toFixed(1)}px, 0)`;
      }
      if (parallaxOrb1) {
        parallaxOrb1.style.transform = `translate3d(${((scrollRatio - 0.5) * -40).toFixed(1)}px, ${((scrollRatio - 0.3) * -100).toFixed(1)}px, 0)`;
      }
      if (parallaxOrb2) {
        parallaxOrb2.style.transform = `translate3d(${((scrollRatio - 0.5) * 40).toFixed(1)}px, ${((scrollRatio - 0.6) * 100).toFixed(1)}px, 0)`;
      }
      if (parallaxBeam) {
        parallaxBeam.style.transform = `translate3d(0, ${((scrollRatio - 0.4) * -90).toFixed(1)}px, 0) rotate(-15deg)`;
      }
    }

    ticking = false;
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  update();
}

/* ==========================================================================
   2. HEADER SCROLL EFFECT
   ========================================================================== */
function setupHeaderScroll() {
  const header = document.querySelector('.site-header');
  if (!header) return;

  let lastState = false;

  const onScroll = () => {
    if (window.innerWidth <= 768) return;
    const isScrolled = window.scrollY > 40;
    if (isScrolled !== lastState) {
      lastState = isScrolled;
      header.classList.toggle('header-hidden', isScrolled);
      header.classList.toggle('scrolled', isScrolled);
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true });
}

/* ==========================================================================
   3. HIGH-SPEED SCROLL REVEAL OBSERVER
   ========================================================================== */
function setupScrollReveal() {
  const revealElements = document.querySelectorAll(
    '.reveal, .reveal-up, .reveal-fade, .reveal-scale, .reveal-left, .reveal-right, .reveal-stagger, .reveal-3d, .reveal-scale-3d, .reveal-stagger-3d'
  );

  if (!('IntersectionObserver' in window)) {
    revealElements.forEach(el => el.classList.add('active'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('active');
        observer.unobserve(entry.target);
      }
    });
  }, {
    rootMargin: '0px 0px -40px 0px',
    threshold: 0.05
  });

  revealElements.forEach(el => observer.observe(el));
}

/* ==========================================================================
   4. SMARTPHONE MOCKUP CAROUSEL (TOUCH SWIPE & BUTTONS)
   ========================================================================== */
function scrollPhoneCarousel(direction) {
  const track = document.getElementById('phone-track');
  if (!track) return;

  const firstSlide = track.querySelector('.phone-mockup');
  const slideWidth = firstSlide ? firstSlide.offsetWidth : 450;
  const gap = 24;

  track.scrollBy({
    left: direction * (slideWidth + gap),
    behavior: 'smooth'
  });
}

function setupPhoneCarousel() {
  const track = document.getElementById('phone-track');
  if (!track) return;

  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;

  track.addEventListener('mousedown', (e) => {
    isDown = true;
    track.style.cursor = 'grabbing';
    track.style.scrollBehavior = 'auto';
    startX = e.pageX - track.offsetLeft;
    scrollLeft = track.scrollLeft;
  }, { passive: true });

  const stopDrag = () => {
    if (!isDown) return;
    isDown = false;
    track.style.cursor = 'grab';
    track.style.scrollBehavior = 'smooth';
  };

  track.addEventListener('mouseleave', stopDrag, { passive: true });
  track.addEventListener('mouseup', stopDrag, { passive: true });

  track.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    const x = e.pageX - track.offsetLeft;
    const walk = (x - startX) * 1.3;
    track.scrollLeft = scrollLeft - walk;
  }, { passive: true });
}

window.scrollPhoneCarousel = scrollPhoneCarousel;

/* ==========================================================================
   5. FAQ ACCORDION
   ========================================================================== */
function setupFaq() {
  const faqRows = document.querySelectorAll('.faq-row');
  faqRows.forEach(row => {
    const btn = row.querySelector('.faq-q');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const isOpen = row.classList.contains('open');
      faqRows.forEach(r => {
        if (r !== row) r.classList.remove('open');
      });
      row.classList.toggle('open', !isOpen);
    });
  });
}

/* ==========================================================================
   6. DOWNLOAD TOAST NOTIFICATION
   ========================================================================== */
function triggerToast() {
  const box = document.getElementById('toast-box');
  if (!box) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    <span>Iniciando download do <strong>APK Capital City</strong>...</span>
    <div class="toast-progress"></div>
  `;

  box.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, 2800);
}

window.triggerToast = triggerToast;

/* ==========================================================================
   7. HERO TITLE TYPEWRITER ANIMATION
   ========================================================================== */
function setupTypewriterAnimation() {
  const target = document.getElementById('hero-typewriter');
  if (!target) return;

  const words = ['Roleplay', 'SAMP', 'Oficial', 'Android', 'Ios', 'Windows'];
  let wordIndex = 0;
  let charIndex = words[0].length;
  let isDeleting = true;

  function tick() {
    const currentWord = words[wordIndex];
    let nextDelay = 120;

    if (isDeleting) {
      charIndex--;
      target.textContent = currentWord.substring(0, charIndex);
      nextDelay = 60;
    } else {
      charIndex++;
      target.textContent = currentWord.substring(0, charIndex);
      nextDelay = 110;
    }

    if (!isDeleting && charIndex === currentWord.length) {
      isDeleting = true;
      nextDelay = 2200;
    } else if (isDeleting && charIndex === 0) {
      isDeleting = false;
      wordIndex = (wordIndex + 1) % words.length;
      nextDelay = 350;
    }

    setTimeout(tick, nextDelay);
  }

  setTimeout(tick, 2000);
}

window.setupTypewriterAnimation = setupTypewriterAnimation;
