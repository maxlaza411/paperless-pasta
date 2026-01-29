# paperless-pasta
Replicates Paperless Post invites. Used this to get into a party (:
This was made in a hurry (1 hr) so it is not clean or anything. Served over cloudflare. Will show animations etc from original. 

Cloudflare Proxy Worker

Usage: /?u=<URL>&name=<name>

Parameters:
  u (required)    - Target URL (URL encoded)
  name (required) - Replacement text
  
Optional:
  sel       - CSS selector for element
  xp        - XPath for element  
  old       - Text to find/replace globally
  ww        - Whole word match (1)
  delay     - Delay in ms (default 300)
  tries     - Retry attempts (default 900)
  interval  - Retry interval ms (default 100)
  persist   - Keep origin cookie (1)
  forceHTML - Force HTML processing (1)
  snapshot  - Freeze after replace (1)

Example:
  /?u=https%3A%2F%2Fexample.com&name=John&sel=.username
