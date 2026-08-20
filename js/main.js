/**
 * CAPITAL CITY ROLEPLAY - CLIENT JAVASCRIPT
 * Typewriter Animation, Scroll Header, Advanced Scroll Reveal, Smartphone Carousel, FAQ & Download Toast.
 */

document.addEventListener('DOMContentLoaded', () => {
  setupTypewriterAnimation();
  setupHeaderScroll();
  setupScrollReveal();
  setupPhoneCarousel();
  setupFaq();
});

/* ==========================================================================
   1. HEADER SCROLL EFFECT (BACKGROUND BLUR & ELEVATION)
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
   2. SMOOTH SCROLL REVEAL & FADING OBSERVER
   ========================================================================== */
function setupScrollReveal() {
  const revealElements = document.querySelectorAll(
    '.reveal, .reveal-up, .reveal-fade, .reveal-scale, .reveal-left, .reveal-right, .reveal-stagger'
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
    threshold: 0.1
  });

  revealElements.forEach(el => observer.observe(el));
}

/* ==========================================================================
   2. SMARTPHONE MOCKUP CAROUSEL (TOUCH SWIPE & MOUSE ARROWS/DRAG)
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
   3. FAQ ACCORDION
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
   4. DOWNLOAD TOAST NOTIFICATION
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
    <span>Iniciando download do <strong>APK Beta v1.9.7</strong>...</span>
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
   5. HERO TITLE TYPEWRITER ANIMATION
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

