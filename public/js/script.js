document.addEventListener("DOMContentLoaded", function () {
  var startBtn = document.getElementById("startBtn");

  function getFeaturedVideos() {
    var videos = window.__FEATURED_VIDEOS__;

    if (!Array.isArray(videos)) {
      return [];
    }

    return videos
      .filter(function (video) {
        return video && typeof video.url === "string" && video.url;
      })
      .slice(0, 4);
  }

  function syncAudioButton(button, isMuted) {
    if (!button) {
      return;
    }

    button.textContent = isMuted ? "Slå lyd på" : "Slå lyd av";
    button.setAttribute("aria-pressed", String(!isMuted));
  }

  function updateVideoSource(video, source, record) {
    if (!video || !record) {
      return source;
    }

    var mimeType = typeof record.mimeType === "string" && record.mimeType ? record.mimeType : "video/mp4";

    if (source) {
      source.src = record.url;
      source.type = mimeType;
    } else {
      source = document.createElement("source");
      source.src = record.url;
      source.type = mimeType;
      video.appendChild(source);
    }

    video.load();
    return source;
  }

  function initCarousel(frame) {
    var videos = getFeaturedVideos();
    var video = frame.querySelector("[data-video-element]");
    var source = video ? video.querySelector("source") : null;
    var audioButton = frame.querySelector("[data-video-audio]");
    var prevButton = frame.querySelector("[data-video-prev]");
    var nextButton = frame.querySelector("[data-video-next]");
    var counter = frame.querySelector("[data-video-counter]");
    var currentIndex = 0;
    var isMuted = true;

    if (!video || videos.length === 0) {
      return;
    }

    if (typeof video.muted === "boolean") {
      isMuted = video.muted;
    }

    function syncCounter() {
      if (counter) {
        counter.textContent = (currentIndex + 1) + " / " + videos.length;
      }
    }

    function setCurrentIndex(nextIndex, shouldPlay) {
      if (!videos.length) {
        return;
      }

      currentIndex = (nextIndex + videos.length) % videos.length;
      source = updateVideoSource(video, source, videos[currentIndex]);

      video.muted = isMuted;

      syncCounter();
      syncAudioButton(audioButton, isMuted);

      if (shouldPlay !== false) {
        video.play().catch(function () {});
      }
    }

    function toggleAudio() {
      isMuted = !isMuted;
      video.muted = isMuted;

      if (!isMuted) {
        video.volume = 1;
        video.play().catch(function () {});
      }

      syncAudioButton(audioButton, isMuted);
    }

    if (prevButton) {
      prevButton.addEventListener("click", function () {
        setCurrentIndex(currentIndex - 1, true);
      });
    }

    if (nextButton) {
      nextButton.addEventListener("click", function () {
        setCurrentIndex(currentIndex + 1, true);
      });
    }

    if (audioButton) {
      audioButton.addEventListener("click", toggleAudio);
    }

    if (videos.length > 1) {
      if (prevButton) {
        prevButton.disabled = false;
      }

      if (nextButton) {
        nextButton.disabled = false;
      }
    }

    setCurrentIndex(0, true);

    video.addEventListener("loadeddata", function () {
      syncAudioButton(audioButton, isMuted);
    });
  }

  if (startBtn) {
    startBtn.addEventListener("click", function () {
      var target = document.querySelector("#samurai");

      if (target) {
        target.scrollIntoView({
          behavior: "smooth"
        });
      }
    });
  }

  document.querySelectorAll("[data-video-carousel]").forEach(function (frame) {
    initCarousel(frame);
  });
});
