import http from 'http'
import url from 'url'
import WebTorrent from 'webtorrent'
import ffmpegPath from 'ffmpeg-static'
import Ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import { PassThrough } from 'stream'

const DEBUG = false
const TOKEN_EXPIRATION = 1000 * 60 * 60 * 24 // 1 day
const client = new WebTorrent()

let myTorrent = null
let authenticationGarbageCollectorIndex = 0

Ffmpeg.setFfmpegPath(ffmpegPath)

// ['token', timestamp]
let authenticatedUsersMap = new Map()

// function convertMkvStreamToMp4(inputStream) {
//   const outputStream = new PassThrough(); // Create a PassThrough stream to handle the output

//   Ffmpeg(inputStream)
//       .outputFormat('mp4') // Set the output format to MP4
//       .videoCodec('libx264') // Set the video codec to libx264 (H.264)
//       .audioCodec('aac') // Set the audio codec to AAC
//       .on('error', (err) => {
//           console.error('Error during conversion:', err);
//           outputStream.emit('error', err); // Emit error on the output stream
//       })
//       .on('end', () => console.log('Finished!'))
//       .pipe(outputStream, {
//         end: true
//       }); // Pipe the ffmpeg output to the PassThrough stream

//   return outputStream; // Return the PassThrough stream
// }

function removeExpiredTokens() {
  authenticatedUsersMap.forEach((value, key) => {
    console.log('Checking token:', key)
    if (Date.now() - value > TOKEN_EXPIRATION) {
      authenticatedUsersMap.delete(key)
    }
  })
}

async function checkUserAuthentication(token) {
  if(authenticatedUsersMap.has(token)) {
    // Check if the token is expired
    if (Date.now() - authenticatedUsersMap.get(token) > TOKEN_EXPIRATION) {
      authenticatedUsersMap.delete(token)
      return false
    }
    return true
  } else {
    // check if user is allowed to stream
    const userResponse = await fetch(`https://dev.opentrust.it/api/collections/mov_users/records?perPage=1`, {
      method: 'GET',
      headers: {
        'Authorization': `${token}`
      }
    });

    if (userResponse.status === 200) {
      const user = await userResponse.json();
      if (user && user.items && user.items.length > 0) {
        authenticatedUsersMap.set(token, Date.now())
        return true
      }
    }

    return false
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true)
  const pathname = parsedUrl.pathname
  const query = parsedUrl.query

  if (
    pathname === '/stream' &&
    query.magnet &&
    query.token &&
    await checkUserAuthentication(query.token)
  ) {
    authenticationGarbageCollectorIndex++
    if (authenticationGarbageCollectorIndex > 100) {
      removeExpiredTokens()
    }
    const torrentId = query.magnet

    if (DEBUG) {
      console.log('Request to stream:', torrentId)
    }

    // Controlla se il torrent è già stato aggiunto
    if (myTorrent) {
      handleTorrent(myTorrent)
    } else {
      client.add(torrentId, handleTorrent)
    }

    function handleTorrent(torrent) {
      myTorrent = torrent
      console.log('Client is downloading:', torrent.infoHash)

      // Verifica se torrent.files è definito
      if (!torrent.files) {
        if (DEBUG) {
          console.error('Torrent files are undefined')
        }
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Torrent files are undefined')
        }
        return
      }

      const fileTypes = [
        { type: 'mp4', mime: 'video/mp4' },
        { type: 'mkv', mime: 'video/x-matroska' },
        { type: 'avi', mime: 'video/x-msvideo' },
        { type: 'mov', mime: 'video/quicktime' },
        { type: 'flv', mime: 'video/x-flv' },
        { type: 'wmv', mime: 'video/x-ms-wmv' },
        { type: 'webm', mime: 'video/webm' },
        { type: 'mpg', mime: 'video/mpeg' },
        { type: 'mpeg', mime: 'video/mpeg' },
        { type: 'm4v', mime: 'video/x-m4v' },
        { type: '3gp', mime: 'video/3gpp' },
        { type: '3g2', mime: 'video/3gpp2' },
        { type: 'ogg', mime: 'video/ogg' },
        { type: 'ogv', mime: 'video/ogg' }
      ];

      // const file = torrent.files.find(file => file.name.endsWith('.mp4'))

      // print torrent file names
      torrent.files.forEach(file => {
        console.log('File:', file.name)
      })

      const file = torrent.files.find(file => {
        return fileTypes.some(fileType => file.name.endsWith(`.${fileType.type}`))
      })

      if (file) {
        const range = req.headers.range
        if (!range) {
          res.writeHead(416, { 'Content-Type': 'text/plain' })
          res.end('Range header required')
          return
        }

        const positions = range.replace(/bytes=/, '').split('-')
        const start = parseInt(positions[0], 10)
        const fileSize = file.length
        const end = positions[1] ? parseInt(positions[1], 10) : fileSize - 1

        if (start >= fileSize) {
          res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` })
          res.end()
          return
        }

        // const mime = fileTypes.find(fileType => file.name.endsWith(`.${fileType.type}`)).mime

        const chunksize = (end - start) + 1
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4'
        })

        console.log('Streaming:', file.name, start, end)

        const stream = file.createReadStream({ start, end });
        // const mp4Stream = convertMkvStreamToMp4(inStream);

        var proc = new Ffmpeg(stream)
          .outputOptions(['-movflags isml+frag_keyframe'])
          .toFormat('mp4')
          .withAudioCodec('copy')
          //.seekInput(offset) this is a problem with piping
          .on('error', function(err,stdout,stderr) {
              console.log('an error happened: ' + err.message);
              console.log('ffmpeg stdout: ' + stdout);
              console.log('ffmpeg stderr: ' + stderr);
          })
          .on('end', function() {
              console.log('Processing finished !');
          })
          .on('progress', function(progress) {
              console.log('Processing: ' + progress.percent + '% done');
          })
          .pipe(res, {end: true});

      } else {
        if (!res.headersSent) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('File not found')
        }
      }
    }

    client.on('error', err => {
      console.error('Error:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    })
  } else {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Bad Request')
  }
})

const PORT = 3000
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`)
})