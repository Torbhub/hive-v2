# Crawl sources

The standing sources the news-scout crawls on every daily-scan task. The
scout proposes additions and removals in its findings note. The edits land
through the normal PR path.

- Kimi Code CLI releases — https://github.com/MoonshotAI/kimi-code/releases
- tmux CHANGES — https://github.com/tmux/tmux/blob/master/CHANGES
- jj releases — https://github.com/jj-vcs/jj/releases
- r/LocalLLaMA, top posts from the past day — https://www.reddit.com/r/LocalLLaMA/top/?t=day
- r/MachineLearning, top posts from the past week — https://www.reddit.com/r/MachineLearning/top/?t=week
- OpenAI News — https://openai.com/news/
- Anthropic News — https://www.anthropic.com/news
- Google DeepMind blog — https://deepmind.google/discover/blog/

On top of these, every run does one web-search pass for new Kimi Code,
agent-orchestration, tmux-automation, CLI-harness, AI/LLM research, model
releases, and significant capability or benchmark news. Follow Reddit and
search leads to a primary paper, model card, repository, or official
announcement when one is available.
