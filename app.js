// server.js
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import qs from 'qs';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import compression from 'compression';

// Configuration - these should be moved to environment variables in production
const config = {
  PORT: process.env.PORT || 5000,
  DOCUMENT_ID: process.env.INSTAGRAM_DOCUMENT_ID || '9510064595728286',
  CACHE_TTL: process.env.CACHE_TTL || 300, // 5 minutes
  REQUEST_TIMEOUT: process.env.REQUEST_TIMEOUT || 10000, // 10 seconds
  MAX_REQUESTS_PER_MINUTE: process.env.MAX_REQUESTS_PER_MINUTE || 30,
  USER_AGENT: process.env.USER_AGENT || 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  // Alternative document IDs to try if the primary one fails
  ALTERNATIVE_DOCUMENT_IDS: [
    '8845758582119845',
    '2394699020250822',
    '2805604155526798'
  ]
};

const app = express();
app.use(compression())
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// Initialize cache for API responses
const cache = new NodeCache({ stdTTL: config.CACHE_TTL, checkperiod: 120 });

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.MAX_REQUESTS_PER_MINUTE,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Serve index.html from current working directory
app.get('/', (req, res) => {
  const indexPath = path.join(process.cwd(), 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).send('index.html not found on server');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// -----------------------------
// Helper: fetch Instagram post data
// -----------------------------
const instagramGetPost = async (urlMedia, documentId = config.DOCUMENT_ID) => {
  try {
    // Check cache first
    const cacheKey = `instagram:${urlMedia}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return cachedData;
    }

    // Try to resolve share redirects (if the URL uses /share/)
    if (urlMedia.includes('/share/')) {
      try {
        const res = await axios.get(urlMedia, { 
          maxRedirects: 5,
          timeout: config.REQUEST_TIMEOUT,
          headers: { 'User-Agent': config.USER_AGENT }
        });
        // If axios followed a redirect, the final URL can be in res.request.res.responseUrl or res.request.path
        if (res.request?.res?.responseUrl) urlMedia = res.request.res.responseUrl;
      } catch (e) {
        console.error('Redirect resolution failed:', e.message);
        // Continue with provided URL
      }
    }

    // Extract shortcode from URL with improved parsing
    let shortcode = null;
    
    // Try different URL patterns
    const urlPatterns = [
      /instagram\.com\/p\/([A-Za-z0-9_-]+)/i,
      /instagram\.com\/reel\/([A-Za-z0-9_-]+)/i,
      /instagram\.com\/tv\/([A-Za-z0-9_-]+)/i,
      /instagram\.com\/reels\/([A-Za-z0-9_-]+)/i
    ];
    
    for (const pattern of urlPatterns) {
      const match = urlMedia.match(pattern);
      if (match && match[1]) {
        shortcode = match[1];
        break;
      }
    }
    
    // Fallback to original method if patterns don't match
    if (!shortcode) {
      const splitUrl = urlMedia.split('/');
      const postTags = ['p', 'reel', 'tv', 'reels'];
      const tagIndex = splitUrl.findIndex((item) => postTags.includes(item));
      shortcode = tagIndex >= 0 ? splitUrl[tagIndex + 1] : null;
    }
    
    if (!shortcode) throw new Error('Invalid Instagram URL (shortcode not found)');

    // Get a CSRF token (best-effort): request main page and extract csrftoken cookie
    const mainResp = await axios.get('https://www.instagram.com/', {
      headers: { 'User-Agent': config.USER_AGENT },
      timeout: config.REQUEST_TIMEOUT,
    });

    const setCookie = mainResp.headers['set-cookie'] || [];
    const csrfCookie = setCookie.find((c) => c && c.startsWith('csrftoken='));
    const csrfToken = csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : null;

    const dataBody = qs.stringify({
      variables: JSON.stringify({
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
      }),
      doc_id: documentId,
    });

    const headers = {
      'User-Agent': config.USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://www.instagram.com/',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-IG-App-ID': '936619743392459', // Add Instagram app ID
    };
    if (csrfToken) headers['X-CSRFToken'] = csrfToken;

    const graphqlResp = await axios.post('https://www.instagram.com/graphql/query', dataBody, {
      headers,
      maxBodyLength: Infinity,
      timeout: config.REQUEST_TIMEOUT,
      validateStatus: (s) => s >= 200 && s < 500,
    });

    if (!graphqlResp.data) {
      console.error('No data from Instagram GraphQL:', graphqlResp.status, graphqlResp.statusText);
      throw new Error('No data from Instagram GraphQL');
    }

    // Log the response structure for debugging (only in development)
    if (process.env.NODE_ENV !== 'production') {
      if (graphqlResp.data.data) {
      }
    }

    // Try multiple paths to extract post data
    let postData = null;
    const possiblePaths = [
      'data.xdt_shortcode_media',
      'data.shortcode_media',
      'data.media',
      'data.xdt_api_v1_media',
      'data.xdt_api_v1_shortcode_media'
    ];
    
    for (const path of possiblePaths) {
      const pathParts = path.split('.');
      let current = graphqlResp.data;
      
      for (const part of pathParts) {
        if (current && current[part]) {
          current = current[part];
        } else {
          current = null;
          break;
        }
      }
      
      if (current) {
        postData = current;
        break;
      }
    }
    
    // If still no data, try to find any media object in the response
    if (!postData) {
      const findMediaObject = (obj, depth = 0) => {
        if (depth > 5) return null; // Prevent infinite recursion
        
        if (obj && typeof obj === 'object') {
          // Check if this looks like a media object
          if (obj.__typename && (
            obj.__typename === 'XDTGraphSidecar' || 
            obj.__typename === 'XDTGraphVideo' || 
            obj.__typename === 'XDTGraphImage'
          )) {
            return obj;
          }
          
          // Recursively search in object properties
          for (const key in obj) {
            const result = findMediaObject(obj[key], depth + 1);
            if (result) return result;
          }
        }
        
        return null;
      };
      
      postData = findMediaObject(graphqlResp.data);
    }
    
    if (!postData) {
      // If we still don't have data, try alternative document IDs
      if (documentId === config.DOCUMENT_ID && config.ALTERNATIVE_DOCUMENT_IDS.length > 0) {
        for (const altDocId of config.ALTERNATIVE_DOCUMENT_IDS) {
          try {
            return await instagramGetPost(urlMedia, altDocId);
          } catch (err) {
            // Continue to the next one
          }
        }
      }
      
   
      
      throw new Error('Only posts/reels supported or Instagram changed response format');
    }

    const formatMedia = (media) => {
      const result = {
        type: media.is_video ? 'video' : 'image',
        url: media.is_video ? media.video_url : media.display_url,
        dimensions: media.dimensions || {},
      };
      
      if (media.is_video) {
        result.thumbnail = media.display_url;
        result.video_view_count = media.video_view_count || 0;
      }
      
      return result;
    };

    const formatComments = (edges = []) => {
      const seen = new Set();
      return edges
        .map((e) => e.node)
        .filter((n) => {
          if (seen.has(n.id)) return false;
          seen.add(n.id);
          return true;
        })
        .map((n) => ({ 
          id: n.id, 
          username: n.owner?.username || 'unknown', 
          text: n.text, 
          created_at: new Date(n.created_at * 1000).toISOString() 
        }));
    };

    const mediaDetails = [];
    const urlList = [];
    
    if (postData.__typename === 'XDTGraphSidecar' || postData.edge_sidecar_to_children) {
      const edges = postData.edge_sidecar_to_children?.edges || [];
      edges.forEach(({ node }) => {
        mediaDetails.push(formatMedia(node));
        urlList.push(node.is_video ? node.video_url : node.display_url);
      });
    } else {
      mediaDetails.push(formatMedia(postData));
      urlList.push(postData.is_video ? postData.video_url : postData.display_url);
    }

    const comments = postData.edge_media_to_parent_comment
      ? formatComments(postData.edge_media_to_parent_comment.edges)
      : [];

    const result = {
      results_number: urlList.length,
      url_list: urlList,
      post_info: {
        owner_username: postData.owner?.username || '',
        owner_fullname: postData.owner?.full_name || '',
        is_verified: !!postData.owner?.is_verified,
        is_private: !!postData.owner?.is_private,
        likes: postData.edge_media_preview_like?.count || 0,
        is_ad: !!postData.is_ad,
        caption: postData.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        comments_count: comments.length,
        taken_at: postData.taken_at ? new Date(postData.taken_at * 1000).toISOString() : null,
      },
      media_details: mediaDetails,
      comments,
    };
    
    // Cache the result
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error('Instagram API error:', err.message);
    // Normalize error message
    if (err.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      return {
        error: `Instagram API error: ${err.response.status} ${err.response.statusText}`,
        details: err.response.data
      };
    } else if (err.request) {
      // The request was made but no response was received
      return {
        error: 'Network error: No response received from Instagram',
        details: err.message
      };
    } else {
      // Something happened in setting up the request that triggered an Error
      return {
        error: err.message || 'Unknown error occurred',
        details: err.stack
      };
    }
  }
};

// -----------------------------
// Post info API
// -----------------------------
app.post('/api/instagram/post', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const postData = await instagramGetPost(url);
    
    // Check if there was an error in the response
    if (postData.error) {
      return res.status(500).json(postData);
    }
    
    return res.json(postData);
  } catch (err) {
    console.error('instagramGetPost error:', err);
    return res.status(500).json({ 
      error: err.message || 'Failed to fetch Instagram post',
      details: err.stack 
    });
  }
});

// -----------------------------
// Stream image (or video) through server
// -----------------------------
app.get('/api/stream', async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'Media URL is required' });

  try {
    // Only allow Instagram domains for security
    const allowed = ['cdninstagram.com', 'fbcdn.net', 'instagram.com'];
    const parsed = new URL(url);
    if (!allowed.some(host => parsed.hostname.includes(host))) {
      return res.status(403).json({ error: 'Blocked host' });
    }

    const response = await axios.get(url, {
      responseType: 'stream',
      headers: {
        'User-Agent': config.USER_AGENT,
        'Referer': 'https://www.instagram.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8,video/mp4,video/webm,video/ogg,video/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      timeout: 30000,
    });

    // Set content-type dynamically
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // Handle content-length if available
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    // Stream to client directly
    response.data.pipe(res);

    response.data.on('end', () => {
    });

    response.data.on('error', err => {
      console.error('Streaming error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream media' });
    });

  } catch (err) {
    console.error('Stream proxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream media', details: err.message });
  }
});

// -----------------------------
// Download API - ENHANCED for both images and videos
// -----------------------------
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Media URL is required' });
  }

  try {
    
    // Determine file extension from URL if not provided in filename
    let finalFilename = filename;
    if (!finalFilename) {
      const urlParts = url.split('?')[0].split('.');
      const extension = urlParts.length > 1 ? urlParts[urlParts.length - 1].toLowerCase() : 'jpg';
      finalFilename = `instagram_media.${extension}`;
    }
    
    // Make sure filename has proper extension
    if (!finalFilename.includes('.')) {
      const urlParts = url.split('?')[0].split('.');
      const extension = urlParts.length > 1 ? urlParts[urlParts.length - 1].toLowerCase() : 'jpg';
      finalFilename = `${finalFilename}.${extension}`;
    }
    
    // Enhanced headers for better Instagram compatibility
    const headers = {
      'User-Agent': config.USER_AGENT,
      'Referer': 'https://www.instagram.com/',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8,video/mp4,video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    };
    
    // Add video-specific headers if it's a video
    if (url.includes('.mp4') || url.includes('video')) {
      headers['Accept'] = 'video/mp4,video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5';
      headers['Sec-Fetch-Dest'] = 'video';
    }
    
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000, // Increased timeout for large files
      headers,
      maxRedirects: 5, // Follow redirects
    });

    // Get content type from response or determine it
    let contentType = response.headers['content-type'];
    if (!contentType) {
      if (url.includes('.jpg') || url.includes('.jpeg')) contentType = 'image/jpeg';
      else if (url.includes('.png')) contentType = 'image/png';
      else if (url.includes('.gif')) contentType = 'image/gif';
      else if (url.includes('.webp')) contentType = 'image/webp';
      else if (url.includes('.mp4')) contentType = 'video/mp4';
      else if (url.includes('.webm')) contentType = 'video/webm';
      else contentType = 'application/octet-stream';
    }

    // Set headers for the response
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${finalFilename}"`
    );
    
    // Handle content-length if available
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    
    // Set cache control headers
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');
    

    // Pipe the stream to the client with error handling
    response.data.pipe(res);

    // Handle stream errors
    response.data.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to download media',
          details: err.message,
        });
      }
    });
    
    // Handle stream end
    response.data.on('end', () => {
    });

  } catch (err) {
    console.error('Download proxy error:', err.message);

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to download media',
        details: err.message,
      });
    }
  }
});

// Simple helper endpoint — returns the same video url as JSON (not used by front-end by default)
app.get('/api/instagram/video', (req, res) => {
  const { videoUrl } = req.query;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });
  // In production, validate host and format
  res.json({ url: videoUrl });
});

// Clear cache endpoint (for debugging)
app.post('/api/clear-cache', (req, res) => {
  cache.flushAll();
  res.json({ message: 'Cache cleared' });
});

// Get cache stats endpoint (for debugging)
app.get('/api/cache-stats', (req, res) => {
  res.json(cache.getStats());
});

// Add a test endpoint to check Instagram API status
app.get('/api/instagram/status', async (req, res) => {
  try {
    // Try to fetch a known public post
    const testUrl = 'https://www.instagram.com/p/C1WwcSvJ7XH/';
    const result = await instagramGetPost(testUrl);
    
    if (result.error) {
      return res.status(500).json({ 
        status: 'error', 
        message: result.error,
        details: result.details
      });
    }
    
    return res.json({ 
      status: 'ok', 
      message: 'Instagram API is working correctly' 
    });
  } catch (err) {
    return res.status(500).json({ 
      status: 'error', 
      message: err.message,
      details: err.stack
    });
  }
});

app.listen(config.PORT, () => console.log(`Server running on port ${config.PORT}`));