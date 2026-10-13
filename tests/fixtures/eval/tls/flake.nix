{
  outputs = _: {
    fetch = builtins.fetchurl {
      url = "https://example.com";
      sha256 = "1174c95bvnns37dvfggf4ikl9zghwjkpklkim679blg0hg4g5p95";
    };
  };
}
