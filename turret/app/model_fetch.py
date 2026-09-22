import logging
import os
import tempfile
import urllib.error
import urllib.request

logger = logging.getLogger("turret.model_fetch")

CHUNK_SIZE = 256 * 1024


def _is_present(path):
    return os.path.isfile(path) and os.path.getsize(path) > 0


def _download(url, dest_path, timeout):
    dest_dir = os.path.dirname(dest_path) or "."
    os.makedirs(dest_dir, exist_ok=True)

    tmp_fd, tmp_path = tempfile.mkstemp(dir=dest_dir, suffix=".part")
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response, os.fdopen(tmp_fd, "wb") as out:
            total = 0
            while True:
                chunk = response.read(CHUNK_SIZE)
                if not chunk:
                    break
                out.write(chunk)
                total += len(chunk)
        os.replace(tmp_path, dest_path)
        logger.info("скачано (%d КБ): %s -> %s", total // 1024, url, dest_path)
        return True
    except (urllib.error.URLError, OSError, ValueError) as exc:
        logger.warning("не удалось скачать %s: %s", url, exc)
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return False


def ensure_model_weights(prototxt_path, model_path, prototxt_url, model_url, timeout=15):
    """Гарантирует наличие файлов весов детектора людей на диске.

    Если оба файла уже сохранены с прошлого запуска - сеть вообще не
    трогаем, работаем полностью офлайн (в т.ч. по localhost без интернета).
    Если файлов нет (первый запуск или их удалили) - пробуем скачать; при
    неудаче (нет сети и т.п.) возвращаем False и НЕ поднимаем исключение -
    вызывающий код (main.py) в этом случае запускает турель в ручном режиме
    без детектора вместо падения.

    Скачивание идёт во временный файл в той же папке и переносится на
    финальный путь только по завершении (os.replace) - оборванная закачка
    никогда не оставит на итоговом месте битый файл, который потом ложно
    посчитали бы "уже скачанным".
    """
    if _is_present(prototxt_path) and _is_present(model_path):
        logger.info("веса детектора уже на диске, скачивание не требуется: %s, %s",
                     prototxt_path, model_path)
        return True

    logger.info("веса детектора не найдены на диске, пробую скачать...")

    ok_prototxt = _is_present(prototxt_path) or _download(prototxt_url, prototxt_path, timeout)
    ok_model = _is_present(model_path) or _download(model_url, model_path, timeout)

    if ok_prototxt and ok_model:
        logger.info("веса детектора готовы")
        return True

    logger.warning(
        "не удалось получить веса детектора (нет интернета?) - "
        "турель запускается в РУЧНОМ режиме, автослежение недоступно"
    )
    return False
