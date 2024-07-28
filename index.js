import http from 'http'
import url from 'url'
import WebTorrent from 'webtorrent'

const DEBUG = false

const client = new WebTorrent()

let myTorrent = null

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true)
  const pathname = parsedUrl.pathname
  const query = parsedUrl.query

  if (pathname === '/stream' && query.magnet) {
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

      const file = torrent.files.find(file => file.name.endsWith('.mp4'))

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

        const chunksize = (end - start) + 1
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4'
        })

        const stream = file.createReadStream({ start, end })
        stream.pipe(res)

        stream.on('error', err => {
          if (DEBUG) {
            console.error('Stream error:', err)
          }
          res.end()
        })

        res.on('close', () => {
          stream.destroy()
        })

        res.on('error', err => {
          if (DEBUG) {
            console.error('Response error:', err)
          }
          stream.destroy()
        })
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