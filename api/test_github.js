export default async function handler(req, res) {
  try {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    
    if (!token || token === "your_github_personal_access_token_here") {
      return res.status(500).json({ status: "error", message: "GITHUB_TOKEN is missing or is set to the default placeholder." });
    }
    if (!repo || repo === "AADI-playz23/my-colab-runner") {
      // It's okay if it's the default, but we should verify we can read it
    }

    // Ping the GitHub API to check if the token is valid
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `token ${token}`
      }
    });

    if (response.ok) {
      return res.status(200).json({ status: "success", message: `GitHub Token is valid! Read access to ${repo} confirmed.` });
    } else {
      const errorData = await response.json();
      return res.status(500).json({ status: "error", message: `GitHub API Error: ${errorData.message}. Make sure your token has 'repo' scopes.` });
    }
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}
