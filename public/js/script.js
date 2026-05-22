document.addEventListener("DOMContentLoaded", function () {
  var startBtn = document.getElementById("startBtn");
  var apiBaseUrl = typeof window.__API_BASE_URL__ === "string" ? window.__API_BASE_URL__.trim() : "";
  var likeStorageKey = "forhonor-video-likes-v1";

  function buildApiUrl(path) {
    var base = apiBaseUrl || window.location.origin;
    return new URL(path, base).toString();
  }

  function readLikeState() {
    if (typeof window.localStorage === "undefined") {
      return {};
    }

    try {
      var raw = window.localStorage.getItem(likeStorageKey);
      if (!raw) {
        return {};
      }

      var parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      return parsed;
    } catch (error) {
      return {};
    }
  }

  function writeLikeState(state) {
    if (typeof window.localStorage === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(likeStorageKey, JSON.stringify(state));
    } catch (error) {
      // Ignore storage quota or privacy-mode failures.
    }
  }

  function applyStoredLikeState(video) {
    var state = readLikeState();
    var entry = video && state[video.id];

    if (!video || !entry || typeof entry !== "object") {
      return video;
    }

    if (typeof entry.likes === "number" && entry.likes >= 0) {
      video.likes = entry.likes;
    }

    video.liked = Boolean(entry.liked);
    return video;
  }

  function persistLikeState(video) {
    if (!video || !video.id) {
      return;
    }

    var state = readLikeState();
    state[video.id] = {
      likes: typeof video.likes === "number" && video.likes >= 0 ? video.likes : 0,
      liked: Boolean(video.liked)
    };
    writeLikeState(state);
  }

  function getFeaturedVideos() {
    var videos = window.__FEATURED_VIDEOS__;

    if (!Array.isArray(videos)) {
      return [];
    }

    return videos
      .filter(function (video) {
        return video && typeof video.url === "string" && video.url;
      })
      .map(function (video) {
        return applyStoredLikeState(video);
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

  function syncLikeButton(button, record, isLiking) {
    if (!button || !record) {
      return;
    }

    var label = button.querySelector("[data-video-like-label]");
    var count = button.querySelector("[data-video-like-count]");
    var liked = Boolean(record.liked);
    var likes = typeof record.likes === "number" && record.likes >= 0 ? record.likes : 0;

    button.classList.toggle("is-liked", liked);
    button.setAttribute("aria-pressed", String(liked));
    button.disabled = liked || Boolean(isLiking);

    if (label) {
      label.textContent = liked ? "Likt" : "Lik";
    }

    if (count) {
      count.textContent = String(likes);
    }
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
    var likeButton = frame.querySelector("[data-video-like]");
    var prevButton = frame.querySelector("[data-video-prev]");
    var nextButton = frame.querySelector("[data-video-next]");
    var counter = frame.querySelector("[data-video-counter]");
    var currentIndex = 0;
    var isMuted = true;
    var isLiking = false;

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
      syncLikeButton(likeButton, videos[currentIndex], isLiking);

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

    function likeCurrentVideo() {
      var record = videos[currentIndex];

      if (!likeButton || !record || record.liked || isLiking) {
        return;
      }

      isLiking = true;
      record.likes = (typeof record.likes === "number" && record.likes >= 0 ? record.likes : 0) + 1;
      record.liked = true;
      persistLikeState(record);
      syncLikeButton(likeButton, record, isLiking);

      fetch(buildApiUrl("/api/videos/" + encodeURIComponent(record.id) + "/like"), {
        method: "POST",
        headers: {
          Accept: "application/json"
        }
      })
        .then(function (response) {
          if (!response.ok) {
            throw new Error("Unable to like video");
          }

          return response.json();
        })
        .then(function (payload) {
          var likes = payload && typeof payload.likes === "number" && payload.likes >= 0 ? payload.likes : record.likes;

          if (likes > record.likes) {
            record.likes = likes;
          }

          persistLikeState(record);
        })
        .catch(function () {
          persistLikeState(record);
        })
        .then(function () {
          isLiking = false;

          if (videos[currentIndex] && videos[currentIndex].id === record.id) {
            syncLikeButton(likeButton, videos[currentIndex], isLiking);
          }
        });
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

    if (likeButton) {
      likeButton.addEventListener("click", likeCurrentVideo);
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
      syncLikeButton(likeButton, videos[currentIndex], isLiking);
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
