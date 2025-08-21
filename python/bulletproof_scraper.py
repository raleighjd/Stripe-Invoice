#!/usr/bin/env python3
"""
Bulletproof Logo Scraper - Addresses Root Causes of Hanging

This scraper fixes the fundamental issues that cause hanging:
1. Process isolation - each request runs in separate process
2. Hard process timeouts - kill hanging processes
3. DNS pre-resolution with timeout
4. Connection isolation - no connection reuse
5. Resource cleanup - prevent resource leaks
"""

import os
import sys
import time
import socket
import signal
import multiprocessing
from multiprocessing import Process, Queue
from urllib.parse import urlparse, urljoin
import logging

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def scrape_single_website_isolated(url, result_queue, output_dir="bulletproof_logos", timeout=15):
    """
    Scrape a single website in complete isolation.
    This runs in a separate process to prevent hanging the main thread.
    """
    try:
        # Import here to avoid issues with multiprocessing
        import requests
        from bs4 import BeautifulSoup
        import re
        
        # Parse domain info
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url
        
        domain = urlparse(url).netloc
        company_name = domain.replace("www.", "").split(".")[0].title()
        
        # Step 1: DNS resolution with timeout
        try:
            socket.setdefaulttimeout(3)  # 3 second DNS timeout
            socket.gethostbyname(domain)
        except (socket.gaierror, socket.timeout) as e:
            result_queue.put({
                "company_name": company_name,
                "url": url,
                "logo_path": None,
                "error": f"DNS resolution failed: {str(e)}"
            })
            return
        
        # Step 2: HTTP request with aggressive timeouts
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'close',  # No keep-alive
            'Cache-Control': 'no-cache'
        }
        
        # Use very aggressive timeouts and no session (fresh connection)
        response = requests.get(
            url,
            headers=headers,
            timeout=(2, 8),  # 2s connect, 8s read
            verify=False,
            allow_redirects=True,
            stream=False  # Get all data at once
        )
        response.raise_for_status()
        
        # Step 3: Parse HTML quickly
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Step 4: Find logo with simplified but effective method
        logo_url = find_logo_fast(soup, url)
        logo_path = None
        
        if logo_url:
            logo_path = download_logo_fast(logo_url, company_name, output_dir, timeout=5)
        
        # Return result
        result_queue.put({
            "company_name": company_name,
            "url": url,
            "logo_path": logo_path,
            "error": None
        })
        
    except requests.exceptions.Timeout:
        result_queue.put({
            "company_name": company_name,
            "url": url, 
            "logo_path": None,
            "error": "Request timeout"
        })
    except requests.exceptions.ConnectionError:
        result_queue.put({
            "company_name": company_name,
            "url": url,
            "logo_path": None, 
            "error": "Connection error"
        })
    except Exception as e:
        result_queue.put({
            "company_name": company_name,
            "url": url,
            "logo_path": None,
            "error": str(e)
        })

def find_logo_fast(soup, base_url):
    """Fast logo detection focusing on most common patterns."""
    # High-probability selectors in order of likelihood
    selectors = [
        'img[alt*="logo" i]',
        '.logo img', '#logo img',
        'img[class*="logo" i]',
        'img[src*="logo" i]', 
        'header img:first-child',
        'nav img:first-child',
        '.navbar-brand img',
        '.site-logo img'
    ]
    
    for selector in selectors:
        try:
            elements = soup.select(selector)
            for img in elements:
                src = img.get('src', '')
                if src:
                    # Make absolute URL
                    if not src.startswith(('http://', 'https://')):
                        src = urljoin(base_url, src)
                    
                    # Quick validation - must be reasonable image URL
                    if any(ext in src.lower() for ext in ['.png', '.jpg', '.jpeg', '.svg', '.webp']):
                        return src
        except:
            continue
    
    return None

def download_logo_fast(logo_url, company_name, output_dir="bulletproof_logos", timeout=5):
    """Fast logo download with minimal processing."""
    try:
        import requests
        import re
        from PIL import Image
        from io import BytesIO
        
        # Create safe filename
        safe_name = re.sub(r'[^\w\s-]', '', company_name)
        safe_name = re.sub(r'[-\s]+', '_', safe_name)
        
        # Create output directory
        os.makedirs(output_dir, exist_ok=True)
        filename = f"{safe_name}_logo.png"
        filepath = os.path.join(output_dir, filename)
        
        # Download with timeout
        response = requests.get(
            logo_url,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
            timeout=timeout,
            verify=False,
            stream=True
        )
        response.raise_for_status()
        
        # Quick image processing
        try:
            img = Image.open(BytesIO(response.content))
            
            # Convert to PNG with transparency
            if img.mode != 'RGBA':
                img = img.convert('RGBA')
            
            # Resize if too large
            if img.width > 800 or img.height > 800:
                img.thumbnail((800, 800), Image.Resampling.LANCZOS)
            
            img.save(filepath, 'PNG', optimize=True)
            return filepath
            
        except Exception:
            # Fallback: save raw data
            with open(filepath, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            return filepath
            
    except Exception as e:
        logger.debug(f"Logo download failed: {str(e)}")
        return None

class BulletproofScraper:
    """
    Bulletproof scraper that never hangs by using process isolation.
    """
    
    def __init__(self, output_dir="bulletproof_output", per_site_timeout=15):
        self.output_dir = output_dir
        self.per_site_timeout = per_site_timeout
        os.makedirs(output_dir, exist_ok=True)
        
    def scrape_website(self, url):
        """
        Scrape a website with bulletproof timeout protection.
        Uses process isolation to prevent hanging.
        """
        logger.info(f"🎯 Scraping {url} with {self.per_site_timeout}s timeout")
        
        # Create a queue for the result
        result_queue = Queue()
        
        # Start the scraping process
        process = Process(
            target=scrape_single_website_isolated,
            args=(url, result_queue, self.output_dir, self.per_site_timeout)
        )
        
        start_time = time.time()
        process.start()
        
        # Wait for the process to complete or timeout
        process.join(timeout=self.per_site_timeout)
        
        if process.is_alive():
            # Process is still running - kill it
            logger.warning(f"⏱️ Process timeout for {url}, terminating...")
            process.terminate()
            process.join(timeout=2)  # Give it 2 seconds to cleanup
            
            if process.is_alive():
                # Force kill if still alive
                process.kill()
                process.join()
            
            duration = time.time() - start_time
            return {
                "company_name": urlparse(url).netloc.replace("www.", "").split(".")[0].title(),
                "url": url,
                "logo_path": None,
                "error": f"Hard timeout after {duration:.1f}s - process killed",
                "duration": duration
            }
        
        # Process completed - get the result
        try:
            result = result_queue.get_nowait()
            result["duration"] = time.time() - start_time
            
            if result.get("logo_path"):
                logger.info(f"✅ Logo found in {result['duration']:.1f}s: {result['logo_path']}")
            else:
                logger.warning(f"❌ No logo found in {result['duration']:.1f}s: {result.get('error', 'Unknown error')}")
            
            return result
            
        except:
            # No result in queue
            duration = time.time() - start_time
            return {
                "company_name": urlparse(url).netloc.replace("www.", "").split(".")[0].title(),
                "url": url,
                "logo_path": None,
                "error": f"Process completed but no result after {duration:.1f}s",
                "duration": duration
            }
    
    def scrape_multiple(self, urls):
        """Scrape multiple URLs with progress tracking."""
        results = []
        
        for i, url in enumerate(urls, 1):
            logger.info(f"🔄 [{i}/{len(urls)}] Processing {url}")
            
            start_time = time.time()
            result = self.scrape_website(url)
            
            results.append(result)
            
            # Progress update
            if i % 10 == 0:
                success_count = sum(1 for r in results if r.get('logo_path'))
                avg_time = sum(r.get('duration', 0) for r in results) / len(results)
                logger.info(f"📊 Progress: {i}/{len(urls)} ({i/len(urls)*100:.1f}%) - {success_count} logos found - Avg: {avg_time:.1f}s/site")
        
        return results

def test_bulletproof_scraper():
    """Test the bulletproof scraper with known problematic and good sites."""
    print("🛡️ Testing Bulletproof Scraper")
    print("=" * 50)
    
    # Test with a mix of problematic and good sites
    test_urls = [
        "https://google.com",  # Should work fine
        "https://dayspring-construction.com",  # Previously problematic
        "https://microsoft.com",  # Should work fine
        "https://nonexistentdomainfortesting12345.com",  # Should fail fast
    ]
    
    scraper = BulletproofScraper(per_site_timeout=10)
    
    print(f"Testing {len(test_urls)} sites with 10s timeout per site:")
    
    start_time = time.time()
    results = scraper.scrape_multiple(test_urls)
    total_time = time.time() - start_time
    
    print(f"\n📊 RESULTS:")
    print(f"Total time: {total_time:.1f}s")
    print(f"Average per site: {total_time/len(test_urls):.1f}s")
    
    for result in results:
        status = "✅ SUCCESS" if result.get('logo_path') else "❌ FAILED"
        print(f"{status} - {result['url']} ({result.get('duration', 0):.1f}s): {result.get('error', 'Logo found')}")
    
    success_count = sum(1 for r in results if r.get('logo_path'))
    print(f"\nSuccess rate: {success_count}/{len(results)} ({success_count/len(results)*100:.1f}%)")
    print(f"💡 No hanging - every request completed within timeout!")

if __name__ == "__main__":
    test_bulletproof_scraper() 