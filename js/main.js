/**
 * CAPITAL CITY ROLEPLAY - CLIENT JAVASCRIPT
 * High-Performance Scroll Engine (Parallax, 3D Perspective Reveal, Neon Progress, RAF Loop, Typewriter, FAQ & Mockup Carousel)
 */

document.addEventListener('DOMContentLoaded', () => {
  setupTypewriterAnimation();
  setupHeaderScroll();
  setupScrollReveal();
  setupPhoneCarousel();
  setupFaq();
  setupScrollEngine();
  setupInteractiveCards3D();
});

/* ==========================================================================
   1. ADVANCED SCROLL ENGINE (RAF PARALLAX & NEON PROGRESS INDICATOR)
   ========================================================================== */
function setupScrollEngine() {
  const progressBar = document.getElementById('scroll-progress');
  const heroBg = document.getElementById('hero-bg-parallax');
  const heroContent = document.getElementById('hero-content');
  const ambientGlow = document.getElementById('scroll-ambient-glow');

  let latestScrollY = window.scrollY;
  let ticking = false;
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let glowX = mouseX;
  let glowY = mouseY;

  // Track mouse movement for subtle ambient backlight flare
  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }, { passive: true });

  const onScroll = () => {
    latestScrollY = window.scrollY;
    requestTick();
  };

  const requestTick = () => {
    if (!ticking) {
      requestAnimationFrame(updateScrollVisuals);
      ticking = true;
    }
  };

  const updateScrollVisuals = () => {
    const scrollY = latestScrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;

    // 1. Update Neon Scroll Progress Bar
    if (progressBar && docHeight > 0) {
      const scrollPercent = Math.min(Math.max((scrollY / docHeight) * 100, 0), 100);
      progressBar.style.width = `${scrollPercent}%`;
    }

    // 2. Parallax Effects on Hero Section
    if (scrollY < window.innerHeight * 1.2) {
      if (heroBg) {
        const bgOffset = scrollY * 0.38;
        const bgScale = 1 + scrollY * 0.00025;
        heroBg.style.transform = `translate3d(0, ${bgOffset}px, 0) scale(${bgScale})`;
      }

      if (heroContent) {
        const contentOffset = scrollY * 0.16;
        const opacityVal = Math.max(1 - scrollY / 650, 0);
        heroContent.style.transform = `translate3d(0, ${contentOffset}px, 0)`;
        heroContent.style.opacity = opacityVal.toFixed(3);
      }
    }

    // 3. Ambient Glow follow scroll & mouse with soft lerp
    if (ambientGlow) {
      glowX += (mouseX - glowX) * 0.08;
      glowY += (mouseY - glowY) * 0.08;
      ambientGlow.style.transform = `translate3d(${glowX}px, ${glowY}px, 0) translate(-50%, -50%)`;
    }

    ticking = false;
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  updateScrollVisuals();
}

/* ==========================================================================
   2. HEADER SCROLL EFFECT (BACKGROUND BLUR & ELEVATION)
   ========================================================================== */
function setupHeaderScroll() {
  const header = document.querySelector('.site-header');
  if (!header) return;

  const onScroll = () => {
    if (window.scrollY > 30) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ==========================================================================
   3. 3D PERSPECTIVE SCROLL REVEAL OBSERVER
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
    root: null,
    rootMargin: '0px 0px -50px 0px',
    threshold: 0.08
  });

  revealElements.forEach(el => observer.observe(el));
}

/* ==========================================================================
   4. 3D TILT EFFECT ON CARDS AND MOCKUPS
   ========================================================================== */
function setupInteractiveCards3D() {
  const cards = document.querySelectorAll('.icon-card, .icon-step-card');

  cards.forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = ((y - centerY) / centerY) * -5;
      const rotateY = ((x - centerX) / centerX) * 5;

      card.style.transform = `perspective(600px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-3px)`;
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
}

/* ==========================================================================
   5. SMARTPHONE MOCKUP CAROUSEL (TOUCH SWIPE & MOUSE ARROWS/DRAG)
   ========================================================================== */
function scrollPhoneCarousel(direction) {
  const track = document.getElementById('phone-track');
  if (!track) return;

  const firstSlide = track.querySelector('.phone-mockup');
  const slideWidth = firstSlide ? firstSlide.offsetWidth : 500;
  const gap = 36;

  track.scrollBy({
    left: direction * (slideWidth + gap),
    behavior: 'smooth'
  });
}

function setupPhoneCarousel() {
  const track = document.getElementById('phone-track');
  if (!track) return;

  // Desktop Mouse Drag to Scroll
  let isDown = false;
  let startX;
  let scrollLeft;

  track.addEventListener('mousedown', (e) => {
    isDown = true;
    track.style.cursor = 'grabbing';
    track.style.scrollBehavior = 'auto';
    track.style.scrollSnapType = 'none';
    startX = e.pageX - track.offsetLeft;
    scrollLeft = track.scrollLeft;
  });

  track.addEventListener('mouseleave', () => {
    if (!isDown) return;
    isDown = false;
    track.style.cursor = 'grab';
    track.style.scrollBehavior = 'smooth';
    track.style.scrollSnapType = 'x mandatory';
  });

  track.addEventListener('mouseup', () => {
    if (!isDown) return;
    isDown = false;
    track.style.cursor = 'grab';
    track.style.scrollBehavior = 'smooth';
    track.style.scrollSnapType = 'x mandatory';
  });

  track.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - track.offsetLeft;
    const walk = (x - startX) * 1.5;
    track.scrollLeft = scrollLeft - walk;
  });
}

window.scrollPhoneCarousel = scrollPhoneCarousel;

/* ==========================================================================
   6. FAQ ACCORDION
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
      if (isOpen) {
        row.classList.remove('open');
      } else {
        row.classList.add('open');
      }
    });
  });
}

/* ==========================================================================
   7. DOWNLOAD TOAST NOTIFICATION
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

  setTimeout(() => toast.classList.add('show'), 15);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

window.triggerToast = triggerToast;

/* ==========================================================================
   8. HERO TITLE TYPEWRITER ANIMATION
   Cycles periodically between: Roleplay -> SAMP -> Beta
   ========================================================================== */
function setupTypewriterAnimation() {
  const target = document.getElementById('hero-typewriter');
  if (!target) return;

  const words = ['Roleplay', 'SAMP', 'Beta', 'APK próprio'];
  let wordIndex = 0;
  let charIndex = words[0].length;
  let isDeleting = true; // start by deleting the initial pre-rendered word

  function tick() {
    const currentWord = words[wordIndex];
    let nextDelay = 120;

    if (isDeleting) {
      charIndex--;
      target.textContent = currentWord.substring(0, charIndex);
      nextDelay = 65; // speed up when backspacing
    } else {
      charIndex++;
      target.textContent = currentWord.substring(0, charIndex);
      nextDelay = 120; // natural typing cadence
    }

    if (!isDeleting && charIndex === currentWord.length) {
      // Completed writing the full word: hold on screen for readability
      isDeleting = true;
      nextDelay = 2200;
    } else if (isDeleting && charIndex === 0) {
      // Completed backspacing: switch to the next word
      isDeleting = false;
      wordIndex = (wordIndex + 1) % words.length;
      nextDelay = 380; // short breath before typing next word
    }

    setTimeout(tick, nextDelay);
  }

  // Initial delay so user reads the default "Roleplay" first
  setTimeout(tick, 2200);
}

window.setupTypewriterAnimation = setupTypewriterAnimation;
