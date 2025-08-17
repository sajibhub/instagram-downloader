import express from 'express';
import axios from 'axios';
import cors from "cors"
import qs from 'qs';
import path from "path"


const app = express();
app.use(express.json());
app.use(cors())

app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

// -----------------------------
// 1️⃣ Get Instagram post info
// -----------------------------
const instagramGetPost = async (urlMedia) => {
  try {
    // Resolve share redirects
    if (urlMedia.includes('/share/')) {
      const res = await axios.get(urlMedia);
      urlMedia = res.request.path;
    }

    const splitUrl = urlMedia.split('/');
    const postTags = ['p', 'reel', 'tv', 'reels'];
    const index = splitUrl.findIndex(item => postTags.includes(item)) + 1;
    const shortcode = splitUrl[index];
    if (!shortcode) throw new Error('Invalid Instagram URL');

    const { headers } = await axios.get('https://www.instagram.com/');
    const csrfCookie = headers['set-cookie']
      ?.find(c => c.startsWith('csrftoken='));
    if (!csrfCookie) throw new Error('CSRF token not found');
    const csrfToken = csrfCookie?.split(';')[0].split('=')[1];

    const DOCUMENT_ID = '9510064595728286';
    const dataBody = qs.stringify({
      variables: JSON.stringify({
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null
      }),
      doc_id: DOCUMENT_ID
    });

    const { data } = await axios.post('https://www.instagram.com/graphql/query', dataBody, {
      headers: {
        'X-CSRFToken': csrfToken,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0'
      },
      maxBodyLength: Infinity
    });

    const postData = data.data?.xdt_shortcode_media;
    if (!postData) throw new Error('Only posts/reels supported, check the link');

    const formatMedia = (media) =>
      media.is_video
        ? { type: 'video', url: media.video_url, thumbnail: media.display_url, dimensions: media.dimensions, video_view_count: media.video_view_count }
        : { type: 'image', url: media.display_url, dimensions: media.dimensions };

    const formatComments = (edges = []) => {
      const seen = new Set();
      return edges.map(e => e.node)
        .filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; })
        .map(n => ({ id: n.id, username: n.owner.username, text: n.text, created_at: new Date(n.created_at * 1000).toISOString() }));
    };

    const mediaDetails = [];
    const urlList = [];
    if (postData.__typename === 'XDTGraphSidecar') {
      postData.edge_sidecar_to_children.edges.forEach(({ node }) => {
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

    return {
      results_number: urlList.length,
      url_list: urlList,
      post_info: {
        owner_username: postData.owner.username,
        owner_fullname: postData.owner.full_name,
        is_verified: postData.owner.is_verified,
        is_private: postData.is_private,
        likes: postData.edge_media_preview_like.count,
        is_ad: postData.is_ad,
        caption: postData.edge_media_to_caption?.edges?.[0]?.node.text || '',
        comments_count: comments.length
      },
      media_details: mediaDetails,
      comments
    };
  } catch (err) {
    throw new Error(`Instagram request failed: ${err.message}`);
  }
};

// -----------------------------
// 2️⃣ Post info API
// -----------------------------
app.post('/api/instagram/post', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const postData = await instagramGetPost(url);
    res.json(postData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/instagram/media', async (req, res) => {
  const { mediaUrl } = req.query;
  
  if (!mediaUrl) {
    return res.status(400).json({ error: 'mediaUrl query parameter is required' });
  }

  try {
    // Fetch the media from Instagram
    const response = await axios.get(mediaUrl, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.instagram.com/',
        // Add any other headers that might be needed
      }
    });

    // Set appropriate headers for the response
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Length', response.headers['content-length'] || 0);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    
    // Stream the media to the client
    response.data.pipe(res);
  } catch (error) {
    console.error('Error fetching media:', error);
    res.status(500).json({ error: 'Failed to fetch media' });
  }
})


const PORT =  5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
