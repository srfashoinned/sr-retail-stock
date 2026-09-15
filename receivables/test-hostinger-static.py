from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import NoAlertPresentException
import time

URL = "http://127.0.0.1:8090/?home=1&static=1&test=hostinger"


def make_driver():
    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--window-size=390,844")
    options.add_argument("--disable-gpu")
    return webdriver.Chrome(options=options)


def wait_text(driver, selector, needle, timeout=12):
    WebDriverWait(driver, timeout).until(
        lambda d: needle.lower() in d.find_element(By.CSS_SELECTOR, selector).text.lower()
    )


def assert_no_alert(driver, label):
    try:
        alert = driver.switch_to.alert
        text = alert.text
        alert.accept()
        raise AssertionError(f"{label} opened alert: {text}")
    except NoAlertPresentException:
        return


def click(driver, selector):
    driver.execute_script("document.querySelector(arguments[0]).click()", selector)


def click_text(driver, text):
    found = driver.execute_script(
        """
        const needle = arguments[0].toLowerCase();
        const nodes = [...document.querySelectorAll('button, tr[data-code], [data-code]')];
        const node = nodes.find(el => (el.textContent || '').toLowerCase().includes(needle));
        if (!node) return false;
        node.scrollIntoView({block:'center'});
        node.click();
        return true;
        """,
        text,
    )
    if not found:
        raise AssertionError(f"Could not find clickable text: {text}")


def main():
    driver = make_driver()
    failures = []
    try:
        driver.get(URL)
        wait_text(driver, "#dbStatus", "saved Retail Daddy copy")
        wait_text(driver, "#kpis", "Customers")
        assert_no_alert(driver, "home load")

        click(driver, "#quickProfitToday")
        time.sleep(1.5)
        assert_no_alert(driver, "Profit Today")
        wait_text(driver, "#profileName", "Profitability")
        wait_text(driver, "#tabContent", "Billwise Profitability")

        driver.get(URL)
        wait_text(driver, "#dbStatus", "saved Retail Daddy copy")
        click_text(driver, "Shaikh Nizamuddin")
        time.sleep(1.5)
        assert_no_alert(driver, "Shaikh Nizamuddin profile")
        wait_text(driver, "#profileName", "Shaikh Nizamuddin")
        wait_text(driver, "#profileStats", "9,000")

        for tab in ["bills", "payments", "outstanding", "items", "summary", "ledger"]:
            click(driver, f'.tab[data-tab="{tab}"]')
            time.sleep(0.4)
            assert_no_alert(driver, f"{tab} tab")
            if not driver.find_element(By.CSS_SELECTOR, "#tabContent").text.strip():
                failures.append(f"{tab} tab rendered empty")

        click(driver, "#ledgerWhatsApp")
        time.sleep(0.5)
        assert_no_alert(driver, "Ledger WhatsApp")
        wait_text(driver, "#whatsappModal", "Send Reminder")
        click(driver, "#closeWhatsApp")

        driver.get(URL)
        wait_text(driver, "#dbStatus", "saved Retail Daddy copy")
        click(driver, "#quickAll")
        wait_text(driver, "#customers", "Customers")
        driver.execute_script("document.querySelector('#searchBox').value='nizamuddin'; document.querySelector('#searchBox').dispatchEvent(new Event('input', {bubbles:true}))")
        time.sleep(0.5)
        wait_text(driver, "#customerRows", "Shaikh Nizamuddin")

        logs = driver.get_log("browser")
        serious = [row for row in logs if row.get("level") in ("SEVERE", "ERROR")]
        if serious:
            failures.append(f"Browser console errors: {serious[:3]}")

        if failures:
            raise AssertionError("; ".join(failures))

        print("PASS hostinger static click flow")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
