# Instagram Video & Image Downloader

A web-based Instagram post downloader built with **Node.js (Express)** and **Vanilla JS/HTML frontend**.  
Allows users to fetch post info (images, videos, captions, likes, comments) and download media directly via a backend proxy.

---

## Features

- Fetch Instagram post info (username, full name, likes, comments, captions)
- Display multiple media types: images, videos, carousels (sidecar posts)
- Video view count and verified badges support
- Download media with real-time progress modal
- Backend proxy avoids CORS issues when fetching media
- Fully responsive UI using TailwindCSS

---

[DEMO](https://instagram.sajib.xyz)

1. Enter Instagram post URL in the input box.
2. Click **Search** to fetch post details.
3. Preview images/videos and comments.
4. Click the download button to save media to your device.

---

## Installation

```bash
git clone https://github.com/sajibhub/instagram-downloader.git
cd instagram-downloader
npm install
node server.js

```

The server runs on http://localhost:5000

# API Endpoints
```
POST /api/instagram/post
```

Fetch Instagram post info.

### Request Body:
```
{
  "url": "https://www.instagram.com/p/POST_SHORTCODE/"
}
```

### Response Example:
```
{
  "results_number": 2,
  "url_list": [...],
  "post_info": {
    "owner_username": "username",
    "owner_fullname": "Full Name",
    "is_verified": true,
    "likes": 1234,
    "caption": "Post caption",
    "comments_count": 10
  },
  "media_details": [...],
  "comments": [...]
}

```


GET /api/instagram/media?mediaUrl=URL

Proxy endpoint to fetch media (image/video) from Instagram.

Supports streaming download


Frontend

index.html – UI with TailwindCSS

Loading spinner, progress bars, and error handling

Supports multiple media items per post

Download modal with real-time progress