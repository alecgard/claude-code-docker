Running Claude Code in Docker container, using GCloud Vertex AI. 

1. Store the Vertex AI Service Account JSON at `~/.config/claude-vertex/sa.json`. 
2. `make build`
3. `make claude` - run Docker container containing Claude Code.
4. `claude` - open Claude Code inside container.

Mounted at `../claude-workspace` directory - use this for persisting code across container restarts.

Global Claude config is stored at `./claude-config`, for perisisting across container restarts.